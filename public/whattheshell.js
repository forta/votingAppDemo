(async function () {
  'use strict';
  // This page reads a public sequence projection and never receives the bot
  // key. Anonymous slot actions use only the player's occupation ID and PIN.
  const $ = id => document.getElementById(id);
  const lang = window.AppClient.i18n.getCurrentLanguage();
  const text = await fetch(`/games/whattheshell/whattheshell_${lang}.json`).then(r => r.json());
  const t = (key, values = {}) => Object.entries(values).reduce((v, [k, x]) => v.replaceAll(`{${k}}`, x), text[key] || key);
  document.documentElement.lang = lang; document.title = text.title;
  document.querySelectorAll('[data-i18n]').forEach(e => { e.textContent = t(e.dataset.i18n); });
  $('language').value = lang; $('language').onchange = () => window.AppClient.i18n.setLanguage($('language').value);
  let connection = null; let selectedSlot = null; let snapshot = null; let busy = false; let refreshTimer = null; let countdownTimer = null;
  let serverClockMs = Date.now(); let serverClockTick = performance.now(); let lastCountdownText = null;
  const turnDurationMs = 30_000;
  const colors = ['#bc5546', '#4087b5', '#ca9635', '#8b64ae', '#3a947f'];
  const selectionKey = () => connection ? `whattheshell:${connection.seqId}:slot` : null;
  const loadSelection = () => { try { selectedSlot = JSON.parse(localStorage.getItem(selectionKey())); } catch { selectedSlot = null; } };
  const saveSelection = () => { if (selectionKey() && selectedSlot) localStorage.setItem(selectionKey(), JSON.stringify(selectedSlot)); };
  const setStatus = (value, connected = false) => { $('status').textContent = value; $('indicator').classList.toggle('connected', connected); };
  const formatDate = value => value ? new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : text.notAvailable;
  async function api(operation, body = {}) { const command = `slotseqs ${operation} ${Object.entries(body).map(([k, v]) => `--${k}=${typeof v === 'string' && v.includes(' ') ? JSON.stringify(v) : v}`).join(' ')}`; const response = await fetch('/cli/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }) }); const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.error || text.connectionError); return result.data; }
  function renderBoard() { $('board').replaceChildren(); for (let cell = 0; cell < 81; cell++) { const button = document.createElement('button'); button.className = 'cell'; const label = `${'ABCDEFGHJ'[cell % 9]}${Math.floor(cell / 9) + 1}`; button.textContent = label; button.ariaLabel = t('cell', { cell: label }); button.onclick = () => propose(cell); $('board').append(button); } updateBoard(); }
  const proposalCell = slot => { const option = snapshot?.ballot?.options?.[slot.proposal]; const cell = Number(option?.text); return Number.isInteger(cell) ? cell : null; };
  function updateBoard() { document.querySelectorAll('.cell').forEach((button, cell) => { button.classList.remove('selected', 'proposal', 'black', 'white', 'egg'); button.style.removeProperty('--proposal-color'); const value = snapshot?.board?.[cell]; if (value === 'black' || value === 'white' || value === 'egg') button.classList.add(value); if (value === 'egg' && snapshot?.eggNumbers?.[cell] !== undefined) button.dataset.eggNumber = snapshot.eggNumbers[cell]; else delete button.dataset.eggNumber; const proposals = (snapshot?.slots || []).filter(slot => proposalCell(slot) === cell); if (proposals.length) { button.classList.add('proposal'); button.style.setProperty('--proposal-color', colors[proposals[0].slotNumber - 1]); button.title = proposals.map(slot => `${t('slot', { n: slot.slotNumber })} · ${slot.alias || ''}`).join(', '); } if (selectedSlot?.proposalCell === cell) button.classList.add('selected'); button.disabled = value !== null && value !== undefined; }); }
  function renderRoundInfo() {
    const outcome = snapshot?.outcome;
    if (outcome?.state === 'finished') $('game-result').textContent = t('gameWon', { color: t(outcome.winner === 'black' ? 'teamColor' : 'machineColor') });
    else if (outcome?.state === 'draw') $('game-result').textContent = t('gameDraw');
    else if (snapshot?.sequenceState === 'finished') $('game-result').textContent = snapshot?.lastCompletedBallot?.description || t('gameInactive');
    else if (snapshot?.ballot?.description) $('game-result').textContent = snapshot.ballot.description;
    else if (snapshot?.sequenceState === 'paused' && snapshot?.lastCompletedBallot?.resolution?.totalVotes === 0) $('game-result').textContent = t('noVotesPause');
    else if (snapshot?.lastCompletedBallot?.resolution) {
      const resolution = snapshot.lastCompletedBallot.resolution;
      if (resolution.totalVotes === 0) $('game-result').textContent = t('noVotesPause');
      else if (resolution.randomlySelected && Number.isInteger(resolution.winningChoice)) {
        const cell = Number(snapshot.lastCompletedBallot.options[resolution.winningChoice]?.text);
        const label = Number.isInteger(cell) ? `${'ABCDEFGHJ'[cell % 9]}${Math.floor(cell / 9) + 1}` : '';
        $('game-result').textContent = t('randomTieWinner', { cell: label });
      } else if (resolution.hasWinner && Number.isInteger(resolution.winningChoice)) {
        const cell = Number(snapshot.lastCompletedBallot.options[resolution.winningChoice]?.text);
        const label = Number.isInteger(cell) ? `${'ABCDEFGHJ'[cell % 9]}${Math.floor(cell / 9) + 1}` : '';
        $('game-result').textContent = t('teamMoved', { cell: label });
      } else $('game-result').textContent = t('noWinningVote');
    }
    else $('game-result').textContent = outcome?.state === 'sudden_death' ? t('suddenDeath') : '';
    $('created-at').textContent = snapshot ? t('createdAt', { time: formatDate(snapshot.createdAt) }) : '';
    $('turns-completed').textContent = snapshot ? t('turnsCompleted', { count: snapshot.completedTurns || 0 }) : '';
    $('last-turn-at').textContent = snapshot ? t('lastTurnAt', { time: snapshot.lastTurnAt ? formatDate(snapshot.lastTurnAt) : text.notAvailable }) : '';
    renderCountdown();
    const hasCurrentSlot = Boolean(selectedSlot?.occupationId && new Date(selectedSlot.expiresAt).getTime() > Date.now());
    $('start-game').hidden = !(['waiting', 'paused'].includes(snapshot?.sequenceState) && hasCurrentSlot && !snapshot?.ballot);
    $('start-game').textContent = t(snapshot?.sequenceState === 'paused' ? 'resumeGame' : 'startGame');
    const actions = $('ballot-actions'); actions.replaceChildren();
    const ballot = snapshot?.ballot; const isInformational = ballot?.options?.length === 1 && !Number.isInteger(Number(ballot.options[0].text));
    if (isInformational && selectedSlot) { const button = document.createElement('button'); button.textContent = t('accept'); button.onclick = () => castChoice(0); actions.append(button); }
  }
  function renderSlots() { $('slots').replaceChildren(); (snapshot?.slots || []).forEach(slot => { const button = document.createElement('button'); button.className = 'slot'; button.style.setProperty('--slot-color', colors[slot.slotNumber - 1]); button.textContent = slot.occupied || slot.reserved ? `${t('slot', { n: slot.slotNumber })} · ${slot.alias || ''}` : t('slot', { n: slot.slotNumber }); button.disabled = Boolean(selectedSlot && selectedSlot.slotNumber !== slot.slotNumber) || (slot.occupied && selectedSlot?.slotNumber !== slot.slotNumber); button.setAttribute('aria-pressed', String(selectedSlot?.slotNumber === slot.slotNumber)); button.onclick = () => { if (selectedSlot && selectedSlot.slotNumber !== slot.slotNumber) return; $('claim').dataset.slot = slot.slotNumber; $('claim').dataset.reserved = String(Boolean(slot.reserved)); $('alias-field').hidden = Boolean(slot.reserved); $('pin-field').hidden = !slot.reserved; $('alias').required = !slot.reserved; $('claim-pin').required = Boolean(slot.reserved); if (!$('config').open) $('config').showModal(); (slot.reserved ? $('claim-pin') : $('alias')).focus(); }; $('slots').append(button); }); updateBoard(); }
  async function refresh() { if (!connection || busy) return; busy = true; try { const previousTurn = snapshot?.ballot?.turn ?? null; snapshot = await api('public', { seq: connection.seqId }); const serverTime = Date.parse(snapshot.serverTime); if (Number.isFinite(serverTime)) serverClockMs = serverTime; serverClockTick = performance.now(); const mySlot = selectedSlot && snapshot.slots?.find(slot => slot.slotNumber === selectedSlot.slotNumber); if (selectedSlot && (!mySlot?.occupied || (Number.isFinite(serverClockMs) && Date.parse(selectedSlot.expiresAt) <= serverClockMs))) { selectedSlot = null; localStorage.removeItem(selectionKey()); } const turn = snapshot.ballot?.turn ?? null; renderSlots(); const state = snapshot.sequenceState || 'waiting'; $('sequence').textContent = t('sequenceInfo', { name: connection.seqId, state: text.states?.[state] || state, turn: turn ?? '—' }); if (previousTurn !== null && turn !== null && turn !== previousTurn) { if (selectedSlot) { selectedSlot.proposal = null; selectedSlot.proposalCell = null; } saveSelection(); $('preview').textContent = t('turnChanged', { turn }); } renderRoundInfo(); setStatus(text.connected, true); } catch (error) { setStatus(error.message); } finally { busy = false; } }
  function renderCountdown() {
    const element = $('turn-countdown');
    const ballot = snapshot?.ballot;
    const deadline = ballot?.closesAt ? Date.parse(ballot.closesAt)
      : ballot?.createdAt ? Date.parse(ballot.createdAt) + turnDurationMs : NaN;
    let label = '';
    if (Number.isFinite(deadline)) {
      const remaining = Math.max(0, Math.ceil((deadline - (serverClockMs + performance.now() - serverClockTick)) / 1000));
      if (remaining === 0) label = text.timeExpired;
      else {
        const minutes = Math.floor(remaining / 60).toString().padStart(2, '0');
        const seconds = (remaining % 60).toString().padStart(2, '0');
        label = t('timeRemaining', { time: `${minutes}:${seconds}` });
      }
    }
    if (label !== lastCountdownText) { element.textContent = label; lastCountdownText = label; }
  }
  function startSync() { clearInterval(refreshTimer); clearInterval(countdownTimer); refreshTimer = setInterval(refresh, 2500); countdownTimer = setInterval(renderCountdown, 250); }
  async function connectManagedBot(seqId) {
    const response = await fetch(`/api/games/${encodeURIComponent(seqId)}/connect`, { method: 'POST' });
    const result = await response.json();
    if (!response.ok) {
      if (result.error === 'GAME_REQUIRES_A_FRESH_SEQUENCE') throw new Error(text.gameRequiresFresh);
      if (result.error === 'SEQUENCE_NOT_ASSIGNED_TO_THIS_GAME') throw new Error(text.assignmentError);
      throw new Error(text.connectGameError);
    }
  }
  $('claim').onsubmit = async event => { event.preventDefault(); try { const reserved = $('claim').dataset.reserved === 'true'; const pin = $('claim-pin').value; const slotNumber = Number($('claim').dataset.slot); const result = reserved ? await api('claim-reserved-public', { seq: connection.seqId, slot: slotNumber, pin }) : await api('claim-public', { seq: connection.seqId, slot: slotNumber, alias: $('alias').value.trim() }); selectedSlot = { slotNumber, ...result, ...(reserved ? { pin } : {}), proposal: null }; saveSelection(); $('config').close(); if (result.pin) alert(t('pinNotice', { pin: result.pin })); await refresh(); } catch (error) { $('error').textContent = error.message; } };
  $('start-game').onclick = async () => {
    if (!selectedSlot?.occupationId || !connection) return;
    $('start-game').disabled = true;
    try {
      const result = await api('start-public', { seq: connection.seqId, slot: selectedSlot.slotNumber, occupation: selectedSlot.occupationId, pin: selectedSlot.pin });
      if (result.expiresAt) { selectedSlot.expiresAt = result.expiresAt; saveSelection(); }
      setStatus(text.gameStartSent);
      await refresh();
    } catch (error) { await refresh(); setStatus(error.message, Boolean(snapshot)); }
    finally { $('start-game').disabled = false; }
  };
  async function castChoice(choice, cell = null) { if (!selectedSlot || !snapshot?.ballot?.ballotId) { $('preview').textContent = text.chooseSlotOrBallot; return; } try { const result = await api('vote-public', { seq: connection.seqId, slot: selectedSlot.slotNumber, occupation: selectedSlot.occupationId, pin: selectedSlot.pin, ballot: snapshot.ballot.ballotId, choice, revision: selectedSlot.revision }); selectedSlot.revision = result.revision; selectedSlot.expiresAt = result.expiresAt; selectedSlot.proposal = choice; selectedSlot.proposalCell = cell; saveSelection(); updateBoard(); $('preview').textContent = cell === null ? t('ackAccepted') : t('accepted', { cell: `${'ABCDEFGHJ'[cell % 9]}${Math.floor(cell / 9) + 1}` }); await refresh(); } catch (error) { $('preview').textContent = error.message; } }
  async function propose(cell) { if (!selectedSlot || !snapshot?.ballot?.ballotId) { $('preview').textContent = text.chooseSlotOrBallot; return; } const choice = snapshot.ballot.options.findIndex(option => Number(option.text) === cell); if (choice < 0) { $('preview').textContent = text.chooseSlotOrBallot; return; } await castChoice(choice, cell); }
  $('close').onclick = () => $('config').close(); $('refresh').onclick = refresh;
  window.addEventListener('online', refresh); window.addEventListener('offline', () => setStatus(text.connectionError)); document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  renderBoard(); renderSlots();
  const seqId = new URLSearchParams(location.search).get('seq');
  if (seqId && /^[A-Za-z0-9_-]{1,128}$/.test(seqId)) {
    connection = { seqId }; loadSelection(); setStatus(text.connecting);
    connectManagedBot(seqId).then(async () => {
      await refresh();
      if (snapshot) { $('refresh').disabled = false; startSync(); }
    }).catch(async error => {
      await refresh();
      if (snapshot) { $('refresh').disabled = false; startSync(); }
      setStatus(error.message);
    });
  } else {
    setStatus(seqId ? text.sequenceError : text.disconnected);
  }
})();
