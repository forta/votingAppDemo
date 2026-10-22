"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { VoteEventRelay } = require("../lib/vote-event-relay");

test("starts the integration runner when the event relay reads an active sequence", async () => {
  const connected = [];
  const relay = new VoteEventRelay({
    client: { _execRemote: async () => ({ success: true, data: { sequenceState: "playing" } }) },
    gameManager: { connect: async seqId => { connected.push(seqId); } }
  });
  const entry = {
    seqId: "seq-1", accessSecret: "", pendingEvents: 1, stopped: false, busy: false,
    updateCount: 0, initialSnapshotPending: true, subscribers: new Set()
  };

  await relay.flush(entry);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(connected, ["seq-1"]);
  assert.equal(entry.initialSnapshotPending, false);
  assert.equal(entry.updateCount, 1);
});

test("does not start a game runner before a player starts the sequence", async () => {
  const connected = [];
  const relay = new VoteEventRelay({
    client: { _execRemote: async () => ({ success: true, data: { sequenceState: "waiting" } }) },
    gameManager: { connect: async seqId => { connected.push(seqId); } }
  });
  const entry = { seqId: "seq-2", accessSecret: "", pendingEvents: 1, stopped: false, busy: false, updateCount: 0, initialSnapshotPending: true, subscribers: new Set() };
  await relay.flush(entry);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(connected, []);
});
