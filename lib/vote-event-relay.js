'use strict';

/** Shares one backend game-state subscription per sequence and batches public snapshots. */

const WebSocket = require('ws');

class VoteEventRelay {
  constructor({ client, gameManager, WebSocketClient = WebSocket, flushIntervalMs = 1000 }) {
    this.client = client;
    this.gameManager = gameManager;
    this.WebSocketClient = WebSocketClient;
    this.flushIntervalMs = flushIntervalMs;
    this.sequences = new Map();
  }

  async subscribe(seqId, response, accessSecret = '') {
    let entry = this.sequences.get(seqId);
    if (!entry) {
      entry = {
        seqId, accessSecret, subscribers: new Set(), pendingEvents: 0,
        updateCount: 0, busy: false, stopped: false, socket: null, timer: null,
        initialSnapshotPending: false
      };
      this.sequences.set(seqId, entry);
      entry.ready = this.start(entry);
    } else if (accessSecret) {
      entry.accessSecret = accessSecret;
    }

    const subscriber = { response, heartbeat: null, closed: false };
    entry.subscribers.add(subscriber);
    response.on('close', () => this.remove(entry, subscriber));
    try {
      await entry.ready;
      if (subscriber.closed || response.destroyed) return;
      response.status(200).set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      response.flushHeaders?.();
      this.send(subscriber, 'ready', { count: 0 });
      if (entry.lastSnapshot) {
        this.send(subscriber, 'state-updated', { eventCount: 0, updateCount: entry.updateCount, snapshot: entry.lastSnapshot });
      } else if (!entry.initialSnapshotPending) {
        entry.initialSnapshotPending = true;
        entry.pendingEvents += 1;
      }
      subscriber.heartbeat = setInterval(() => {
        if (!response.destroyed && !response.writableEnded) response.write(': keep-alive\n\n');
      }, 25000);
    } catch (error) {
      this.remove(entry, subscriber);
      throw error;
    }
  }

  async start(entry) {
    const { token } = await this.gameManager.findAssignedSequence(entry.seqId);
    const upstreamUrl = new URL('/admin/events', this.gameManager.config.serverUrl);
    upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new this.WebSocketClient(upstreamUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });
    entry.socket = socket;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => finish(Object.assign(new Error('EVENT_SUBSCRIPTION_TIMEOUT'), { status: 504 })), 10000);
      const finish = error => {
        if (settled) return;
        settled = true;
        entry.readySettled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else {
          entry.timer = setInterval(() => { void this.flush(entry); }, this.flushIntervalMs);
          resolve();
        }
      };
      socket.on('open', () => socket.send(JSON.stringify({
        type: 'subscribe', events: ['sequence.game-state.changed'],
        scope: { kind: 'sequence', id: entry.seqId }
      })));
      socket.on('message', raw => {
        let message;
        try { message = JSON.parse(raw.toString()); } catch { return; }
        if (message.type === 'subscription.confirmed') {
          const accepted = (message.scopes || []).some(scope => scope?.kind === 'sequence' && scope.id === entry.seqId)
            && !(message.rejectedScopes || []).some(scope => scope?.kind === 'sequence' && scope.id === entry.seqId);
          if (!accepted) return finish(Object.assign(new Error('EVENT_SUBSCRIPTION_DENIED'), { status: 403 }));
          finish();
        } else if (message.type === 'sequence.game-state.changed' && message.seqId === entry.seqId) {
          entry.pendingEvents += 1;
        }
      });
      socket.on('error', () => {
        if (!entry.readySettled) {
          finish(Object.assign(new Error('EVENT_SUBSCRIPTION_FAILED'), { status: 502 }));
        } else {
          this.broadcast(entry, 'stream-error', { error: 'EVENT_SUBSCRIPTION_FAILED' });
          this.stop(entry);
        }
      });
      socket.on('close', () => {
        if (!entry.readySettled) {
          entry.readySettled = true;
          finish(Object.assign(new Error('EVENT_SUBSCRIPTION_CLOSED'), { status: 502 }));
        } else if (!entry.stopped) {
          this.broadcast(entry, 'stream-closed', {});
          this.stop(entry);
        }
      });
    });
  }

  async flush(entry) {
    if (entry.stopped || entry.busy || entry.pendingEvents === 0) return;
    const eventCount = entry.pendingEvents;
    entry.pendingEvents = 0;
    entry.busy = true;
    try {
      const accessOption = entry.accessSecret ? ` --accessSecret=${JSON.stringify(entry.accessSecret)}` : '';
      const result = await this.client._execRemote(`slotseqs public --seq=${entry.seqId}${accessOption}`, null);
      if (!result?.success) throw new Error(result?.error || 'Could not refresh game vote state.');
      const snapshot = result.data?.data || result.data || {};
      entry.updateCount += 1;
      entry.lastSnapshot = snapshot;
      entry.initialSnapshotPending = false;
      if (this.gameManager && ["playing", "paused"].includes(snapshot.sequenceState)) {
        void this.gameManager.connect(entry.seqId).catch(() => {});
      }
      this.broadcast(entry, 'state-updated', {
        eventCount,
        updateCount: entry.updateCount,
        snapshot
      });
    } catch {
      // Keep failed batches pending so the next tick retries instead of losing a refresh.
      entry.pendingEvents += eventCount;
    } finally {
      entry.busy = false;
    }
  }

  send(subscriber, event, data) {
    const { response } = subscriber;
    if (subscriber.closed || response.destroyed || response.writableEnded) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(entry, event, data) {
    for (const subscriber of entry.subscribers) this.send(subscriber, event, data);
  }

  remove(entry, subscriber) {
    if (subscriber.closed) return;
    subscriber.closed = true;
    clearInterval(subscriber.heartbeat);
    entry.subscribers.delete(subscriber);
    if (!entry.subscribers.size) this.stop(entry);
  }

  stop(entry) {
    if (entry.stopped) return;
    entry.stopped = true;
    clearInterval(entry.timer);
    if (this.sequences.get(entry.seqId) === entry) this.sequences.delete(entry.seqId);
    for (const subscriber of entry.subscribers) {
      subscriber.closed = true;
      clearInterval(subscriber.heartbeat);
      if (!subscriber.response.writableEnded) subscriber.response.end();
    }
    entry.subscribers.clear();
    if (entry.socket && [this.WebSocketClient.OPEN, this.WebSocketClient.CONNECTING].includes(entry.socket.readyState)) {
      entry.socket.close();
    }
  }
}

module.exports = { VoteEventRelay };
