(async function () {
  'use strict';

  /* Coordinates the generic player view: slot claiming, public sequence state,
   * ballot actions, and renderer selection for generic, Ink, or WTS sequences. */

  const $ = id => document.getElementById(id);
  const language = localStorage.getItem('game-player-language') ||
    (navigator.language || 'es').slice(0, 2).toLowerCase();
  const text = await fetch(`player/play_${language}.json?v=20261022-2`)
    .then(response => response.ok ? response.json() : Promise.reject(new Error('Translation not found')))
    .catch(() => fetch('player/play_en.json').then(response => response.json()));
  const t = (key, values = {}) => Object.entries(values)
    .reduce((value, [name, item]) => value.replaceAll(`{${name}}`, item), text[key] || key);
  const seqId = new URLSearchParams(location.search).get('seq');
  const explicitView = new URLSearchParams(location.search).get('view');
  let selectedRenderer = ['generic', 'ink', 'whattheshell'].includes(explicitView) ? explicitView : 'generic';
  let snapshot = null;
  let selectedSlot = null;
  let slotExpired = false;
  let voteFailure = null;
  let dialogSlot = null;
  let busy = false;
  let restoredSelection = false;
  let refreshTimer = null;
  let backgroundRefreshFailures = 0;
  let countdownTimer = null;
  let syncStarted = false;
  let sequenceEventsConnected = false;
  let serverClockMs = Date.now();
  let serverClockTick = performance.now();
  let lastCountdownText = null;
  let sequenceEventsStarted = false;
  let sequenceEventController = null;
  let pendingSnapshot = null;
  let runnerAttempted = false;
  let runnerMessage = null;
  let runnerFailed = false;
  const selectionKey = `sequence-play:${seqId}:slot`;
  const rendererKey = `sequence-play:${seqId}:renderer`;
  const accessKey = `sequence-play:${seqId}:access`;
  let accessSecret = sessionStorage.getItem(accessKey) || '';
  const publicSlotOperations = new Set(['public', 'claim-public', 'claim-reserved-public', 'recover-public', 'start-public', 'vote-public', 'release-public']);

  document.documentElement.lang = language;
  document.title = t('title');
  $('brand-name').textContent = 'Kunsido';
  $('games-link').textContent = t('gamesLink');
  document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
  $('language').value = ['es', 'en', 'eo'].includes(language) ? language : 'es';
  $('language').setAttribute('aria-label', t('languageLabel'));
  $('language').onchange = () => {
    localStorage.setItem('game-player-language', $('language').value);
    location.reload();
  };

  const sessionToken = localStorage.getItem('voting_app_token') || localStorage.getItem('voting_platform_token') || localStorage.getItem('koncenso_token');
  const storedUser = localStorage.getItem('voting_app_user') || localStorage.getItem('voting_platform_user') || localStorage.getItem('kunsido_user');
  if (sessionToken && storedUser) {
    try {
      const user = JSON.parse(storedUser);
      const displayName = user?.alias || user?.name || user?.email || user?.id;
      if (displayName) {
        $('account-name').textContent = t('signedInAs', { name: displayName });
        $('account-name').hidden = false;
      }
    } catch {}
  }

  const setStatus = (message, error = false) => {
    $('status').textContent = message;
    $('status').classList.toggle('error', error);
  };
  const quote = value => JSON.stringify(String(value));
  async function writeClipboard(value) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('Clipboard copy failed');
  }
  function createCopyButton(value) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-sequence-id';
    button.title = t('copyId');
    button.setAttribute('aria-label', t('copyId'));
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"></path></svg>';
    button.onclick = async () => {
      try {
        await writeClipboard(value);
        button.title = t('idCopied');
        button.setAttribute('aria-label', t('idCopied'));
      } catch {
        button.title = t('copyFailed');
        button.setAttribute('aria-label', t('copyFailed'));
      }
      setTimeout(() => { button.title = t('copyId'); button.setAttribute('aria-label', t('copyId')); }, 1600);
    };
    return button;
  }
  const saveSelection = () => selectedSlot
    ? localStorage.setItem(selectionKey, JSON.stringify(selectedSlot))
    : localStorage.removeItem(selectionKey);
  const loadSelection = () => {
    try { selectedSlot = JSON.parse(localStorage.getItem(selectionKey)); }
    catch { selectedSlot = null; }
  };

  async function readCommandResponse(response) {
    const incomplete = () => Object.assign(
      new Error(t('incompleteResponse', { status: response.status })),
      { code: 'INCOMPLETE_RESPONSE' }
    );
    let body;
    try { body = await response.text(); }
    catch { throw incomplete(); }
    if (!body) throw incomplete();
    let result;
    try { result = JSON.parse(body); }
    catch { throw incomplete(); }
    if (!result || typeof result !== 'object') throw incomplete();
    return result;
  }
  async function command(operation, fields = {}) {
    const commandFields = { ...fields };
    if (accessSecret && publicSlotOperations.has(operation)) commandFields.accessSecret = accessSecret;
    const args = Object.entries(commandFields).map(([key, value]) =>
      `--${key}=${typeof value === 'string' ? quote(value) : value}`).join(' ');
    const response = await fetch('cli/execute', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: `slotseqs ${operation} ${args}` })
    });
    const result = await readCommandResponse(response);
    if (!response.ok || !result.success) {
      const error = new Error(result.error || t('requestError'));
      error.code = result.code || null;
      if (error.code === 'GAME_ACCESS_CODE_REQUIRED') {
        accessSecret = '';
        sessionStorage.removeItem(accessKey);
        openAccessDialog();
      }
      throw error;
    }
    return result.data;
  }

  function openAccessDialog() {
    if (!$('access-dialog').open) $('access-dialog').showModal();
    $('access-code').value = '';
    $('access-code-error').textContent = '';
    $('access-code').focus();
  }

  function scheduleFallbackRefresh(delayMs = null) {
    if (!syncStarted) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      const refreshed = await refresh(null, true);
      const retryDelay = refreshed ? null : Math.min(30000, 5000 * (2 ** Math.min(backgroundRefreshFailures, 2)));
      scheduleFallbackRefresh(retryDelay);
    }, delayMs ?? (sequenceEventsConnected ? 30000 : 5000));
  }

  function setSequenceEventConnection(connected) {
    sequenceEventsConnected = connected;
    const status = $("sequence-event-connection");
    if (status) status.textContent = t(connected ? "sequenceEventsConnected" : "sequenceEventsDisconnected");
    scheduleFallbackRefresh();
  }

  function startSync() {
    if (syncStarted) return;
    syncStarted = true;
    scheduleFallbackRefresh();
    countdownTimer = setInterval(() => { renderCountdown(); checkSlotExpiry(); }, 250);
  }

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function connectSequenceStateEvents() {
    if (sequenceEventsStarted) return;
    sequenceEventsStarted = true;
    sequenceEventController = new AbortController();
    while (!sequenceEventController.signal.aborted) {
      try {
        const response = await fetch('events/sequence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seqId, accessSecret }),
          signal: sequenceEventController.signal
        });
        if (!response.ok || !response.body) {
          const result = await response.json().catch(() => ({}));
          throw new Error(result.error || t('requestError'));
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!sequenceEventController.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() || '';
          for (const block of blocks) {
            const event = block.match(/^event:\s*(.+)$/m)?.[1];
            const payload = block.match(/^data:\s*(.+)$/m)?.[1];
            if (!payload) continue;
            let data;
            try { data = JSON.parse(payload); } catch { continue; }
            if (event === "ready") setSequenceEventConnection(true);
            if (event === 'state-updated') {
              const previous = Number($('sequence-event-count').textContent) || 0;
              $('sequence-event-count').textContent = String(previous + (Number(data.eventCount) || 0));
              if (data.snapshot) void refresh(data.snapshot);
            }
            if (event === 'stream-error' || event === 'stream-closed') {
              setSequenceEventConnection(false);
            }
          }
        }
      } catch (error) {
        if (sequenceEventController.signal.aborted) break;
        sequenceEventsConnected = false;
        const status = $("sequence-event-connection");
        if (status) status.textContent = error.message;
        scheduleFallbackRefresh();
      }
      if (!sequenceEventController.signal.aborted) {
        setSequenceEventConnection(false);
        await wait(3000);
      }
    }
  }

  function appendTextParagraphs(container, value) {
    const paragraphs = String(value || t('noNarrative')).split(/\n\s*\n/).filter(part => part.trim());
    paragraphs.forEach(paragraph => {
      const element = document.createElement('p');
      element.textContent = paragraph.trim();
      container.append(element);
    });
  }

  function appendTimer(container, ballot) {
    lastCountdownText = null;
    const timer = document.createElement('p');
    timer.className = 'timer';
    timer.id = 'turn-countdown';
    timer.setAttribute('role', 'timer');
    timer.setAttribute('aria-live', 'off');
    container.append(timer);
    renderCountdown();
  }

  function renderCountdown() {
    const element = $('turn-countdown');
    if (!element) { lastCountdownText = null; return; }
    const ballot = snapshot?.ballot;
    const deadlineValue = ballot?.phaseClosesAt || ballot?.closesAt;
    const deadline = deadlineValue ? Date.parse(deadlineValue) : NaN;
    let label = '';
    let expired = false;
    if (Number.isFinite(deadline)) {
      const remaining = Math.max(0, Math.ceil((deadline - (serverClockMs + performance.now() - serverClockTick)) / 1000));
      if (!remaining) { label = t('timeExpired'); expired = true; }
      else {
        const minutes = Math.floor(remaining / 60).toString().padStart(2, '0');
        const seconds = (remaining % 60).toString().padStart(2, '0');
        label = t('timeRemaining', { time: `${minutes}:${seconds}` });
      }
    }
    element.classList.toggle('expired', expired);
    if (label !== lastCountdownText) { element.textContent = label; lastCountdownText = label; }
  }

  function checkSlotExpiry() {
    if (!selectedSlot || busy) return;
    const expiry = Date.parse(selectedSlot.expiresAt);
    if (!Number.isFinite(expiry) || expiry > serverClockMs + performance.now() - serverClockTick) return;
    selectedSlot = null;
    slotExpired = true;
    voteFailure = null;
    saveSelection();
    setStatus(t('slotExpired'), true);
    renderSlots();
    renderGame();
    void refresh();
  }

  function createTurnHeading(container, active, turn, showLastAction = false) {
    const heading = document.createElement('p');
    heading.className = 'eyebrow';
    heading.textContent = active ? t('openTurn') : t('closedTurn');
    container.append(heading);
    if (showLastAction) appendLastAction(container);
    if (Number.isInteger(turn)) {
      const detail = document.createElement('p');
      detail.className = 'meta';
      detail.textContent = t('turnLabel', { turn });
      container.append(detail);
    }
  }

  function canVote(ballot) {
    return Boolean(snapshot?.ballot && !snapshot.ballot.closed &&
      (ballot.state || 'ready') === 'ready' && snapshot.sequenceState === 'playing' &&
      selectedSlot);
  }

  function currentVoteText(ballot) {
    if (!selectedSlot || selectedSlot.votedBallotId !== ballot?.ballotId) return null;
    if (selectedSlot.abstainedBallotId === ballot.ballotId) return t('currentAbstention');
    const selected = ballot.options?.find((option, index) => (option.choiceId ?? index) === selectedSlot.proposalChoiceId);
    if (!selected) return null;
    let choice = selected.text || t('choice', { number: ballot.options.indexOf(selected) + 1 });
    if (Array.isArray(snapshot?.board) && snapshot.board.length === 81) {
      const cell = Number.isInteger(selectedSlot.proposalCell) ? selectedSlot.proposalCell : Number(selected.text);
      if (Number.isInteger(cell) && cell >= 0 && cell < 81) choice = cellLabel(cell);
    }
    return t('currentVote', { choice });
  }

  function appendCurrentVote(container, ballot) {
    const value = currentVoteText(ballot);
    if (!value) return;
    const current = document.createElement('p');
    current.className = 'current-vote';
    current.setAttribute('role', 'status');
    current.textContent = value;
    container.append(current);
  }

  function voteCountsByChoice(ballot) {
    return new Map((ballot?.voteCounts || [])
      .filter(item => Number.isInteger(item.choiceId) && Number.isInteger(item.count) && item.count > 0)
      .map(item => [item.choiceId, item.count]));
  }

  function appendVoteCount(element, count, label) {
    if (!count) return;
    const badge = document.createElement('span');
    badge.className = 'vote-count';
    badge.textContent = String(count);
    badge.setAttribute('aria-hidden', 'true');
    element.append(badge);
    element.title = t('votesCount', { count });
    if (label) element.setAttribute('aria-label', `${label} · ${t('votesCount', { count })}`);
  }

  function appendChoiceButtons(container, ballot, isOpen) {
    const list = document.createElement('div');
    list.className = 'choices';
    const voteCounts = voteCountsByChoice(ballot);
    (ballot.options || []).forEach((option, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      const label = option.text || t('choice', { number: index + 1 });
      button.append(document.createTextNode(label));
      appendVoteCount(button, voteCounts.get(option.choiceId ?? index), label);
      if (selectedSlot?.votedBallotId === ballot.ballotId && selectedSlot.abstainedBallotId !== ballot.ballotId
          && selectedSlot.proposalChoiceId === (option.choiceId ?? index)) button.classList.add('selected-choice');
      button.disabled = !isOpen;
      button.onclick = () => castVote(ballot, option.choiceId ?? index);
      list.append(button);
    });
    container.append(list);
  }

  function appendAbstainButton(container, ballot, isOpen) {
    if (!ballot?.allowActiveAbstention) return;
    const actions = document.createElement('div');
    actions.className = 'vote-secondary-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'abstain-button';
    button.textContent = t('abstain');
    button.setAttribute('aria-pressed', String(selectedSlot?.abstainedBallotId === ballot.ballotId));
    button.disabled = !isOpen;
    button.onclick = () => castVote(ballot, null, null, true);
    actions.append(button);
    container.append(actions);
  }


  function appendSequenceEventStatus(container) {
    const status = $("sequence-event-status");
    if (status) container.append(status);
  }

  function renderStoryHandler(container, ballot, active) {
    const narrative = document.createElement('div');
    narrative.className = 'story-text';
    appendTextParagraphs(narrative, ballot.description);
    container.append(narrative);
    const notice = document.createElement('p');
    notice.id = 'notice';
    notice.setAttribute('role', 'status');
    const isOpen = canVote(ballot);
    notice.textContent = voteFailure?.ballotId === ballot.ballotId ? voteFailure.message
      : selectedSlot?.votedBallotId === ballot.ballotId ? t('voteAccepted')
      : isOpen ? t('votePrompt') : active ? selectedSlot ? t('waitingForResolution') : t('claimBeforeVote')
        : snapshot.sequenceState === 'finished' ? t('gameFinished') : t('waitingNext');
    container.append(notice);
    appendCurrentVote(container, ballot);
    appendChoiceButtons(container, ballot, isOpen);
    appendSequenceEventStatus(container);
    appendAbstainButton(container, ballot, isOpen);
  }

  function cellLabel(index) {
    return `${'ABCDEFGHJ'[index % 9]}${Math.floor(index / 9) + 1}`;
  }

  function appendLastAction(container) {
    const action = snapshot?.lastAction;
    if (!action) return;
    const section = document.createElement('section');
    section.className = 'last-action';
    const heading = document.createElement('h2');
    heading.textContent = t(action.functionalityId === 'ink' ? 'lastInkActionHeading' : 'lastActionHeading');
    const detail = document.createElement('p');
    if (action.functionalityId === 'whattheshell') {
      detail.textContent = t('lastWtsAction', {
        turn: action.turn,
        team: Number.isInteger(action.teamMove) ? cellLabel(action.teamMove) : t('pass'),
        machine: Number.isInteger(action.machineMove) ? cellLabel(action.machineMove) : t('pass')
      });
    } else if (action.functionalityId === 'ink' && action.choice) {
      detail.textContent = t('lastInkAction', { turn: action.turn, choice: action.choice });
    } else return;
    section.append(heading, detail);
    container.append(section);
  }

  function renderWtsHandler(container, ballot, active) {
    const legend = document.createElement('div');
    legend.className = 'board-legend';
    const team = document.createElement('span');
    team.textContent = `${t('team')} · ●`;
    const machine = document.createElement('span');
    machine.textContent = `○ · ${t('machine')}`;
    legend.append(team, machine);
    container.append(legend);
    const wrap = document.createElement('div');
    wrap.className = 'board-wrap';
    const board = document.createElement('div');
    board.className = 'board';
    const positions = Array.isArray(snapshot.board) && snapshot.board.length === 81 ? snapshot.board : Array(81).fill(null);
    const optionsByCell = new Map((ballot?.options || []).map((option, index) => [Number(option.text), option.choiceId ?? index]));
    const voteCounts = voteCountsByChoice(ballot);
    positions.forEach((piece, index) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `cell${piece ? ` ${piece}` : ''}`;
      const label = cellLabel(index);
      cell.append(document.createTextNode(label));
      cell.setAttribute('aria-label', cellLabel(index));
      const choice = optionsByCell.get(index);
      appendVoteCount(cell, choice === undefined ? 0 : voteCounts.get(choice), label);
      cell.disabled = Boolean(piece) || choice === undefined || !canVote(ballot);
      if (selectedSlot?.proposalCell === index && selectedSlot.votedBallotId === ballot?.ballotId) {
        cell.classList.add('selected');
      } else if (selectedSlot?.proposalCell === index && selectedSlot.votedBallotId === snapshot.lastCompletedBallot?.ballotId) {
        cell.classList.add('previous-selected');
        cell.title = t('previousVoteCell');
        cell.setAttribute('aria-label', t('previousVoteCell') + ': ' + label);
      }
      cell.onclick = () => { if (choice !== undefined) castVote(ballot, choice, index); };
      board.append(cell);
    });
    wrap.append(board);
    container.append(wrap);
    if (snapshot.eggNumbers) Object.entries(snapshot.eggNumbers).forEach(([index, number]) => {
      const cell = board.children[Number(index)];
      if (cell) { cell.classList.add('egg'); cell.dataset.eggNumber = number; }
    });

    const result = document.createElement('p');
    result.className = 'result-line';
    result.textContent = wtsResultText();
    container.append(result);
    const acknowledgement = active && ballot.options?.length === 1 && !/^\d+$/.test(String(ballot.options[0].text ?? ''))
      && Array.isArray(snapshot.board) && snapshot.board.length === 81;
    if (acknowledgement && selectedSlot) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = t('accept');
      button.disabled = !canVote(ballot);
      button.onclick = () => castVote(ballot, ballot.options[0].choiceId ?? 0);
      container.append(button);
    }
    const notice = document.createElement('p');
    notice.id = 'notice';
    notice.setAttribute('role', 'status');
    notice.textContent = ballot && voteFailure?.ballotId === ballot.ballotId ? voteFailure.message
      : selectedSlot?.votedBallotId === ballot?.ballotId ? t('voteAccepted')
      : canVote(ballot) ? t('votePrompt') : active ? t('waitingForResolution')
        : !snapshot.ballot && !snapshot.lastCompletedBallot ? t('waitingRunner') : t('waitingNext');
    container.append(notice);
    appendCurrentVote(container, ballot);
    appendSequenceEventStatus(container);
    appendAbstainButton(container, ballot, canVote(ballot));
  }

  function wtsResultText() {
    const outcome = snapshot.outcome;
    if (outcome?.state === 'draw') return t('resultDraw');
    if (outcome?.state === 'finished') return t('resultWin', { winner: t(outcome.winner === 'black' ? 'team' : 'machine') });
    const resolution = snapshot.lastCompletedBallot?.resolution;
    const options = snapshot.lastCompletedBallot?.options || [];
    if (resolution?.randomlySelected && Number.isInteger(resolution.winningChoice)) {
      const cell = Number(options[resolution.winningChoice]?.text);
      return t('resultTie', { cell: Number.isInteger(cell) ? cellLabel(cell) : '' });
    }
    if (resolution?.hasWinner && Number.isInteger(resolution.winningChoice)) {
      const cell = Number(options[resolution.winningChoice]?.text);
      return t('resultTeam', { cell: Number.isInteger(cell) ? cellLabel(cell) : '' });
    }
    return '';
  }

  function isWtsOptionBallot(ballot) {
    const options = ballot?.options || [];
    return options.length >= 10 && options.every(option => {
      const value = String(option.text ?? '');
      return /^\d+$/.test(value) && Number(value) >= 0 && Number(value) < 81;
    });
  }

  function isWtsCompatible(ballot) {
    return (Array.isArray(snapshot?.board) && snapshot.board.length === 81) || isWtsOptionBallot(ballot);
  }

  function isInkCompatible(ballot) {
    return !(Array.isArray(snapshot?.board) && snapshot.board.length === 81) && !isWtsOptionBallot(ballot);
  }

  const gameHandlers = {
    generic: renderStoryHandler,
    ink: renderStoryHandler,
    whattheshell: renderWtsHandler
  };

  function renderGame() {
    const container = $('game-view');
    const eventStatus = $('sequence-event-status');
    if (eventStatus?.parentElement === container) container.after(eventStatus);
    const hasWtsBoard = snapshot?.functionalityId === 'whattheshell'
      && Array.isArray(snapshot.board) && snapshot.board.length === 81;
    const ballot = snapshot?.ballot || snapshot?.lastCompletedBallot
      || (hasWtsBoard ? { options: [], voteCounts: [] } : null);
    if (!snapshot || !ballot) {
      container.replaceChildren();
      container.hidden = true;
      lastCountdownText = null;
      return;
    }
    container.hidden = false;
    container.replaceChildren();
    const active = Boolean(snapshot.ballot && !snapshot.ballot.closed);
    const handler = snapshot.functionalityId || selectedRenderer || 'generic';
    const normalizedHandler = handler === 'whattheshell' ? 'whattheshell' : handler === 'ink' ? 'ink' : 'generic';
    createTurnHeading(container, active, ballot.turn, normalizedHandler === 'ink');
    if (normalizedHandler === 'whattheshell') appendLastAction(container);
    if (active) appendTimer(container, ballot);
    if (normalizedHandler === 'whattheshell' && !isWtsCompatible(ballot)) {
      if (!snapshot.functionalityId) {
        selectedRenderer = 'generic';
        $('renderer').value = selectedRenderer;
        localStorage.setItem(rendererKey, selectedRenderer);
        $('renderer-error').textContent = t('rendererMismatch');
        renderGame();
        return;
      }
      container.replaceChildren();
      const error = document.createElement('p');
      error.className = 'error';
      error.textContent = t('rendererMismatch');
      container.append(error);
      return;
    }
    if (normalizedHandler === 'ink' && !snapshot.functionalityId && !isInkCompatible(ballot)) {
      selectedRenderer = 'generic';
      $('renderer').value = selectedRenderer;
      localStorage.setItem(rendererKey, selectedRenderer);
      $('renderer-error').textContent = t('rendererMismatch');
      renderGame();
      return;
    }
    container.dataset.gameHandler = normalizedHandler;
    (gameHandlers[normalizedHandler] || gameHandlers.generic)(container, ballot, active);
  }

  function renderSlots() {
    const container = $('slots');
    container.replaceChildren();
    const slots = snapshot?.slots || [];
    $('slots-hint').textContent = slots.length ? t('slotsHint') : t('noSlots');
    slots.forEach(slot => {
      const button = document.createElement('button');
      const mine = selectedSlot?.slotNumber === slot.slotNumber;
      button.type = 'button';
      button.className = 'slot';
      button.textContent = slot.occupied
        ? `${t('slot', { number: slot.slotNumber })} · ${slot.alias || t('occupied')}${mine ? ` · ${t('you')}` : ''}`
        : slot.reserved ? `${t('slot', { number: slot.slotNumber })} · ${slot.alias || t('reserved')}`
          : `${t('slot', { number: slot.slotNumber })} · ${t('available')}`;
      button.disabled = slot.occupied && !mine;
      button.setAttribute('aria-pressed', String(mine));
      button.onclick = () => { if (!mine) openSlotDialog(slot); };
      container.append(button);
    });
    $('release').hidden = !selectedSlot;
  }

  async function refresh(incomingSnapshot = null, background = false) {
    if (!seqId || !/^[A-Za-z0-9_-]{1,128}$/.test(seqId)) return;
    if (busy) {
      if (incomingSnapshot) pendingSnapshot = incomingSnapshot;
      return false;
    }
    busy = true;
    try {
      const nextSnapshot = incomingSnapshot || await command('public', { seq: seqId });
      if (snapshot && Date.parse(nextSnapshot.serverTime) < Date.parse(snapshot.serverTime)) return true;
      snapshot = nextSnapshot;
      backgroundRefreshFailures = 0;
      void connectSequenceStateEvents();
      const serverTime = Date.parse(snapshot.serverTime);
      if (Number.isFinite(serverTime)) serverClockMs = serverTime;
      serverClockTick = performance.now();
      if (selectedSlot) {
        const slot = snapshot.slots?.find(item => item.slotNumber === selectedSlot.slotNumber);
        if (!slot?.occupied || Date.parse(slot.expiresAt) <= serverClockMs) {
          selectedSlot = null;
          slotExpired = true;
          voteFailure = null;
          saveSelection();
        } else if (!restoredSelection) {
          restoredSelection = true;
          try {
            selectedSlot = { ...selectedSlot, ...await command('recover-public', {
              seq: seqId, slot: selectedSlot.slotNumber, pin: selectedSlot.pin
            }) };
            saveSelection();
          } catch (error) {
            if (error.code === 'INCOMPLETE_RESPONSE') restoredSelection = false;
            else { selectedSlot = null; slotExpired = true; saveSelection(); }
          }
        }
      }
      if (voteFailure && voteFailure.ballotId !== snapshot.ballot?.ballotId) voteFailure = null;
      const handler = snapshot.functionalityId || selectedRenderer || 'generic';
      const normalizedHandler = handler === 'whattheshell' ? 'whattheshell' : handler === 'ink' ? 'ink' : 'generic';
      if (!runnerAttempted && new URLSearchParams(location.search).get('runner') === 'multibot'
          && ['whattheshell', 'ink'].includes(normalizedHandler)) {
        runnerAttempted = true;
        try {
          const response = await fetch('cli/execute', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: `games connect --seqId=${seqId}` })
          });
          const result = await readCommandResponse(response);
          if (!response.ok || !result.success) throw new Error(result.error || t('requestError'));
          runnerMessage = t(result.data?.started ? 'runnerStarted' : 'runnerAlreadyRunning');
        } catch (error) { runnerMessage = error.message; runnerFailed = true; }
      }
      const kindKey = normalizedHandler === 'whattheshell' ? 'wtsTitle' : normalizedHandler === 'ink' ? 'inkTitle' : 'genericTitle';
      $('game-kind').textContent = t(kindKey);
      $('game-description').textContent = t('intro');
      $('renderer-panel').hidden = Boolean(snapshot.functionalityId);
      if (!snapshot.functionalityId) $('renderer').value = selectedRenderer;
      const reportedState = snapshot.sequenceState || 'waiting';
      const state = ['waiting', 'playing', 'paused', 'finished'].includes(reportedState) ? reportedState : 'unknown';
      const sequenceInfo = $('sequence');
      sequenceInfo.replaceChildren();
      sequenceInfo.classList.add('sequence-meta');
      const sequenceTitle = document.createElement('span');
      sequenceTitle.className = 'sequence-title';
      sequenceTitle.textContent = snapshot.sequenceName || t('untitledGame');
      const sequenceState = document.createElement('span');
      sequenceState.className = 'game-state state-' + state;
      sequenceState.textContent = t('state_' + state);
      sequenceInfo.append(sequenceTitle, sequenceState, createCopyButton(seqId));
      $('start').hidden = !(['waiting', 'paused'].includes(state) && selectedSlot && !snapshot.ballot);
      $('start').textContent = t(state === 'paused' ? 'resumeGame' : 'startGame');
      setStatus(slotExpired ? t('slotExpired') : runnerMessage || t(state === 'waiting' ? 'waitingToStart' : state === 'paused' ? 'paused' : state === 'finished' ? 'gameFinished' : 'connected'), slotExpired || runnerFailed);
      renderSlots();
      renderGame();
      if ($('access-dialog').open) $('access-dialog').close();
      return true;
    } catch (error) {
      if (background && snapshot) {
        backgroundRefreshFailures += 1;
        if (backgroundRefreshFailures >= 3) setStatus(error.message, true);
      } else if (error.code === 'GAME_ACCESS_CODE_REQUIRED') setStatus(t('accessCodePrompt'), true);
      else setStatus(error.message, true);
      return false;
    }
    finally {
      busy = false;
      if (pendingSnapshot) {
        const nextSnapshot = pendingSnapshot;
        pendingSnapshot = null;
        void refresh(nextSnapshot);
      }
    }
  }

  function openSlotDialog(slot) {
    dialogSlot = slot;
    $('dialog-title').textContent = t(slot.reserved ? 'reservedTitle' : 'claimTitle', { number: slot.slotNumber });
    $('alias-field').hidden = Boolean(slot.reserved);
    $('pin-field').hidden = !slot.reserved;
    $('alias').required = !slot.reserved;
    $('pin').required = Boolean(slot.reserved);
    $('alias').value = '';
    $('pin').value = '';
    $('dialog-error').textContent = '';
    $('slot-dialog').showModal();
    (slot.reserved ? $('pin') : $('alias')).focus();
  }

  $('slot-form').onsubmit = async event => {
    event.preventDefault();
    if (!dialogSlot || busy) return;
    busy = true;
    $('claim').disabled = true;
    try {
      const fields = { seq: seqId, slot: dialogSlot.slotNumber };
      let result;
      let pin;
      if (dialogSlot.reserved) {
        pin = $('pin').value;
        result = await command('claim-reserved-public', { ...fields, pin });
      } else result = await command('claim-public', { ...fields, alias: $('alias').value.trim() });
      selectedSlot = { ...result, slotNumber: dialogSlot.slotNumber, pin: result.pin || pin };
      slotExpired = false;
      saveSelection();
      $('slot-dialog').close();
      if (result.pin) alert(t('pinNotice', { pin: result.pin }));
      dialogSlot = null;
      restoredSelection = true;
      await refreshAfterAction();
    } catch (error) { $('dialog-error').textContent = error.message; }
    finally { busy = false; $('claim').disabled = false; }
  };

  async function refreshAfterAction() { busy = false; await refresh(); }
  async function castVote(ballot, choiceId, proposalCell = null, abstain = false) {
    if (!selectedSlot || !ballot?.ballotId || busy) return;
    busy = true;
    try {
      const result = await command(abstain ? 'abstain-public' : 'vote-public', {
        seq: seqId, slot: selectedSlot.slotNumber, occupation: selectedSlot.occupationId,
        pin: selectedSlot.pin, ballot: ballot.ballotId, ...(abstain ? {} : { choice: choiceId }), revision: selectedSlot.revision
      });
      voteFailure = null;
      selectedSlot = { ...selectedSlot, revision: result.revision, expiresAt: result.expiresAt,
        votedBallotId: ballot.ballotId, proposalCell,
        proposalChoiceId: abstain ? null : result.choiceId, abstainedBallotId: abstain ? ballot.ballotId : null };
      saveSelection();
      $('notice').textContent = t('voteAccepted');
    } catch (error) {
      if (error.code === 'INCOMPLETE_RESPONSE') restoredSelection = false;
      voteFailure = { ballotId: ballot.ballotId, message: error.message };
      const notice = $('notice');
      if (notice) notice.textContent = error.message;
    }
    finally { busy = false; await refresh(); scheduleFallbackRefresh(3000); }
  }

  $('start').onclick = async () => {
    if (!selectedSlot || busy) return;
    busy = true;
    $('start').disabled = true;
    try {
      const result = await command('start-public', { seq: seqId, slot: selectedSlot.slotNumber,
        occupation: selectedSlot.occupationId, pin: selectedSlot.pin });
      selectedSlot = { ...selectedSlot, ...result };
      saveSelection();
    } catch (error) { setStatus(error.message, true); }
    finally { busy = false; $('start').disabled = false; await refresh(); }
  };
  $('release').onclick = async () => {
    if (!selectedSlot || busy) return;
    busy = true;
    try {
      await command('release-public', { seq: seqId, slot: selectedSlot.slotNumber,
        occupation: selectedSlot.occupationId, pin: selectedSlot.pin });
      selectedSlot = null;
      saveSelection();
      restoredSelection = true;
    } catch (error) { setStatus(error.message, true); }
    finally { busy = false; await refresh(); }
  };
  $('refresh').onclick = () => { void refresh(); };
  $('renderer').onchange = () => {
    const previous = selectedRenderer;
    const next = $('renderer').value;
    const ballot = snapshot?.ballot || snapshot?.lastCompletedBallot;
    if (next === 'whattheshell' && ballot && !isWtsCompatible(ballot)) {
      $('renderer').value = previous;
      $('renderer-error').textContent = t('rendererMismatch');
      return;
    }
    if (next === 'ink' && ballot && !isInkCompatible(ballot)) {
      $('renderer').value = previous;
      $('renderer-error').textContent = t('rendererMismatch');
      return;
    }
    selectedRenderer = next;
    $('renderer-error').textContent = '';
    localStorage.setItem(rendererKey, selectedRenderer);
    renderGame();
  };
  $('cancel').onclick = () => $('slot-dialog').close();
  $('access-code-form').onsubmit = async event => {
    event.preventDefault();
    const value = $('access-code').value.trim().toUpperCase();
    if (!/^[A-Z]{5}$/.test(value)) {
      $('access-code-error').textContent = t('accessCodeFormat');
      return;
    }
    accessSecret = value;
    sessionStorage.setItem(accessKey, accessSecret);
    $('access-dialog').close();
    if (await refresh()) startSync();
  };
  $('access-code-cancel').onclick = () => $('access-dialog').close();
  window.addEventListener('online', () => { void refresh(); });
  window.addEventListener('offline', () => setStatus(t('connectionError'), true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('beforeunload', () => {
    clearTimeout(refreshTimer);
    clearInterval(countdownTimer);
    sequenceEventController?.abort();
  });

  if (!seqId || !/^[A-Za-z0-9_-]{1,128}$/.test(seqId)) {
    setStatus(t('invalidSequence'), true);
    $('refresh').disabled = true;
  } else {
    loadSelection();
    const savedRenderer = localStorage.getItem(rendererKey);
    if (['generic', 'ink', 'whattheshell'].includes(savedRenderer)) selectedRenderer = savedRenderer;
    setStatus(t('connecting'));
    if (await refresh()) startSync();
  }
})();
