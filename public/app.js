/* ============================================================
   Connect — client
   Realtime over WebSocket, with an HTTP long-poll fallback for
   networks/proxies that block upgrades.
   ============================================================ */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_TEXT = 2000;
  const GROUP_WINDOW = 5 * 60 * 1000; // group bubbles from the same author within 5 min

  const els = {
    joinScreen: $('join-screen'), chatScreen: $('chat-screen'),
    joinForm: $('join-form'), joinBtn: $('join-btn'), joinError: $('join-error'),
    nameInput: $('name-input'), roomInput: $('room-input'), diceBtn: $('dice-btn'),
    recentChip: $('recent-chip'), recentBtn: $('recent-btn'),

    sidebar: $('sidebar'), sidebarClose: $('sidebar-close'), drawerBtn: $('drawer-btn'), scrim: $('drawer-scrim'),
    sidebarRoom: $('sidebar-room'), chatRoom: $('chat-room'), headCount: $('head-count'),
    headTransport: $('head-transport'), onlineCount: $('online-count'), memberList: $('member-list'),
    meAvatar: $('me-avatar'), meName: $('me-name'), connState: $('conn-state'), connText: $('conn-text'),
    copyBtn: $('copy-btn'), shareBtn: $('share-btn'), leaveBtn: $('leave-btn'), soundBtn: $('sound-btn'),

    messages: $('messages'), emptyState: $('empty-state'), emptyRoom: $('empty-room'),
    jumpBtn: $('jump-btn'), jumpCount: $('jump-count'), typingLine: $('typing-line'),
    banner: $('banner'), bannerText: $('banner-text'),
    invitePanel: $('invite-panel'), inviteInput: $('invite-input'), inviteHint: $('invite-hint'),
    inviteClose: $('invite-close'), inviteAgain: $('invite-again'),

    composer: $('composer'), msgInput: $('msg-input'), sendBtn: $('send-btn'), counter: $('counter'),
    emojiBtn: $('emoji-btn'), emojiPanel: $('emoji-panel'),
    toastStack: $('toast-stack'),
  };

  const state = {
    name: '', room: '',
    phase: 'join',              // 'join' | 'live'
    transport: null,            // 'ws' | 'poll'
    socket: null, sessionId: null, lastSessionId: null, cursor: 0, pollTimer: null, rejoinTries: 0, joinTries: 0,
    users: [], typing: [], sound: true,
    lastAuthor: null, lastTs: 0, lastDayKey: null, seen: new Set(),
    atBottom: true, unread: 0, baseTitle: document.title,
    typingSent: false, typingStopTimer: null, typingThrottle: 0,
    reconnectAttempts: 0, reconnectTimer: null, joining: false,
  };

  /* ------------------------------------------------------------------ */
  /* utils                                                              */
  /* ------------------------------------------------------------------ */

  const key = (s) => String(s || '').toLowerCase().normalize('NFC');
  const initials = (name) => {
    const parts = String(name).trim().split(/\s+/).slice(0, 2);
    return parts.map((p) => p[0]).join('').toUpperCase() || '?';
  };
  const hash = (str) => { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return Math.abs(h); };
  const avatarBg = (name) => { const h = hash(key(name)) % 360; return `linear-gradient(135deg, hsl(${h} 74% 58%), hsl(${(h + 46) % 360} 76% 45%))`; };
  const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayKey = (ts) => new Date(ts).toDateString();
  const dayLabel = (ts) => {
    const d = new Date(ts), today = new Date(), yest = new Date(Date.now() - 864e5);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yest.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200D\uFE0F\u20E3]+$/u;

  /* localStorage / history can throw inside a sandboxed iframe (opaque origin).
     Everything that touches them goes through these guards so the app still boots. */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* not available */ } },
  };
  const setUrl = (search) => {
    try { history.replaceState(null, '', search); } catch { /* not available */ }
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderRich(container, text) {
    const urlRe = /(https?:\/\/[^\s<>()]+|www\.[^\s<>()]+)/gi;
    let last = 0, m;
    while ((m = urlRe.exec(text)) !== null) {
      if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
      const a = el('a', null, m[0]);
      a.href = /^https?:/i.test(m[0]) ? m[0] : `https://${m[0]}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      container.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
    return container;
  }

  function toast(message, kind = '') {
    const t = el('div', `toast${kind ? ' ' + kind : ''}`, message);
    els.toastStack.appendChild(t);
    setTimeout(() => { t.style.transition = 'opacity .25s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 260); }, 2600);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch { return false; }
  }

  /* ------------------------------------------------------------------ */
  /* join screen                                                        */
  /* ------------------------------------------------------------------ */

  const ROOM_LEFT = ['amber', 'cosmic', 'quiet', 'swift', 'lucky', 'neon', 'hidden', 'golden', 'electric', 'midnight'];
  const ROOM_RIGHT = ['otter', 'harbor', 'comet', 'panda', 'garden', 'rocket', 'falcon', 'lagoon', 'signal', 'ember'];
  const randomRoom = () => `${ROOM_LEFT[Math.floor(Math.random() * ROOM_LEFT.length)]}-${ROOM_RIGHT[Math.floor(Math.random() * ROOM_RIGHT.length)]}-${Math.floor(10 + Math.random() * 90)}`;

  function showJoinError(message) {
    els.joinError.textContent = message;
    els.joinError.hidden = false;
    setJoining(false);
  }

  function setJoining(loading) {
    state.joining = loading;
    els.joinBtn.classList.toggle('loading', loading);
    els.joinBtn.disabled = loading;
  }

  function initJoinScreen() {
    const params = new URLSearchParams(location.search);
    const urlRoom = params.get('room') || params.get('r');
    const savedName = store.get('connect:name') || '';
    const savedRoom = store.get('connect:room') || '';

    if (urlRoom) els.roomInput.value = urlRoom.slice(0, 32);
    else if (savedRoom) els.roomInput.value = savedRoom;

    if (savedName) els.nameInput.value = savedName;
    if (urlRoom || savedRoom) els.recentChip.hidden = false;
    els.recentBtn.textContent = (urlRoom || savedRoom) || '';

    els.recentBtn.onclick = () => { els.roomInput.value = urlRoom || savedRoom; els.roomInput.focus(); };
    els.diceBtn.onclick = () => { els.roomInput.value = randomRoom(); els.roomInput.focus(); };

    setTimeout(() => { (savedName ? (urlRoom || savedRoom ? els.roomInput : els.nameInput) : els.nameInput).focus(); }, 260);
  }

  els.joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.joining || state.phase === 'live') return;
    const name = els.nameInput.value.trim().replace(/\s+/g, ' ').slice(0, 20);
    const room = els.roomInput.value.trim().replace(/\s+/g, ' ').slice(0, 32);

    if (name.length < 2) return showJoinError('Pick a username with at least 2 characters.');
    if (!room) return showJoinError('Room ID is required.');

    state.name = name; state.room = room;
    store.set('connect:name', name);
    store.set('connect:room', room);
    els.joinError.hidden = true;
    setJoining(true);
    connectRealtime();
  });

  /* ------------------------------------------------------------------ */
  /* transports                                                         */
  /* ------------------------------------------------------------------ */

  function setConn(status, text) {
    els.connState.classList.toggle('online', status === 'online');
    els.connState.classList.toggle('offline', status === 'offline');
    els.connText.textContent = text || (status === 'online' ? 'connected' : status === 'offline' ? 'offline' : 'connecting…');
  }

  function banner(show, text, kind = '') {
    els.banner.hidden = !show;
    els.banner.classList.toggle('error', kind === 'error');
    if (text) els.bannerText.textContent = text;
  }

  function clearTransports() {
    if (state.socket) {
      const s = state.socket; state.socket = null;
      try { s.onclose = null; s.onerror = null; s.onmessage = null; s.close(); } catch {}
    }
    if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    state.sessionId = null;
  }

  /** Try WebSocket first; drop to polling if the upgrade never lands. */
  function connectRealtime() {
    clearTransports();
    setConn('connecting');
    banner(state.phase === 'live', 'Reconnecting…');

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try { ws = new WebSocket(`${proto}//${location.host}`); }
    catch { return startPolling(); }

    state.socket = ws;
    let greeted = false, joined = false;
    const giveUp = setTimeout(() => { if (!greeted) { try { ws.close(); } catch {} } }, 5000);

    ws.onopen = () => {
      try {
        ws.send(JSON.stringify({ type: 'join', name: state.name, room: state.room, resume: state.lastSessionId }));
      } catch {}
    };

    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello') { greeted = true; clearTimeout(giveUp); state.lastSessionId = msg.sessionId || state.lastSessionId; return; }
      if (msg.type === 'pong') return;
      if (msg.type === 'error' && msg.fatal) { clearTimeout(giveUp); clearTransports(); return failJoin(msg.message); }
      if (msg.type === 'joined') { joined = true; clearTimeout(giveUp); state.transport = 'ws'; }
      handleEvent(msg);
    };

    ws.onclose = () => {
      clearTimeout(giveUp);
      if (state.socket === ws) state.socket = null;
      if (state.phase !== 'live') { if (!joined) startPolling(); return; }
      scheduleReconnect('Connection lost — reconnecting…');
    };

    ws.onerror = () => { /* onclose follows */ };
  }

  function scheduleReconnect() {
    if (state.phase !== 'live') return;
    state.reconnectAttempts += 1;
    setConn('offline', 'offline');
    banner(true, 'Connection lost — reconnecting…', 'error');

    if (state.reconnectAttempts > 3) return startPolling();   // socket never sticks — switch transport

    const delay = Math.min(900 * 2 ** (state.reconnectAttempts - 1), 6000);
    state.reconnectTimer = setTimeout(() => connectRealtime(), delay);
  }

  /** HTTP long-poll fallback. */
  async function startPolling() {
    clearTransports();
    state.transport = 'poll';
    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: state.name, room: state.room, resume: state.lastSessionId }),
      });
      const data = await res.json();
      if (!data.ok) {
        // a stale name from a dead session blocks us — drop the resume token and retry once
        if (state.lastSessionId) { state.lastSessionId = null; return startPolling(); }
        return failJoin(data.error || 'Could not join the room.');
      }
      state.sessionId = data.sessionId;
      state.lastSessionId = data.sessionId;
      state.cursor = 0;
      state.rejoinTries = 0;
      state.joinTries = 0;
      pollLoop();
    } catch {
      if (state.joinTries >= 4) return failJoin('Could not reach the server. Is it running?');
      state.joinTries += 1;
      banner(true, 'Connection lost — retrying…', 'error');
      state.reconnectTimer = setTimeout(startPolling, Math.min(1500 * 2 ** state.reconnectAttempts++, 8000));
    }
  }

  async function pollLoop() {
    if (state.transport !== 'poll') return;
    try {
      const res = await fetch(`/api/poll?id=${encodeURIComponent(state.sessionId)}&after=${state.cursor}`, { cache: 'no-store' });
      const data = await res.json();
      if (!data.ok) {
        if (state.phase !== 'live' || state.rejoinTries >= 5) return failJoin('The connection timed out. Try joining again.');
        state.rejoinTries += 1;
        setConn('offline', 'reconnecting…');
        state.pollTimer = setTimeout(startPolling, 800);
        return;
      }
      for (const ev of data.events) { state.cursor = ev.seq; handleEvent(ev); }
      state.cursor = Math.max(state.cursor, data.seq);
      if (state.phase === 'live') { state.rejoinTries = 0; setConn('online', 'connected (basic mode)'); banner(false); }
    } catch {
      setConn('offline', 'reconnecting…');
      banner(true, 'Connection lost — retrying…', 'error');
    }
    state.pollTimer = setTimeout(pollLoop, state.phase === 'live' ? 1300 : 350);
  }

  function failJoin(message) {
    state.phase = 'join';
    state.transport = null;
    clearTransports();
    showJoinError(message);
    toast(message, 'err');
  }

  function send(payload, endpoint) {
    if (state.transport === 'ws' && state.socket && state.socket.readyState === 1) {
      try { state.socket.send(JSON.stringify(payload)); return true; } catch {}
    }
    if (state.transport === 'poll' && state.sessionId) {
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: state.sessionId, ...payload }),
      }).catch(() => {});
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* event handling                                                     */
  /* ------------------------------------------------------------------ */

  function handleEvent(ev) {
    switch (ev.type) {
      case 'joined': enterChat(ev); break;
      case 'message': addMessage(ev.message, { animate: true }); break;
      case 'users': renderMembers(ev.users); break;
      case 'typing': renderTyping(ev.users); break;
      case 'notice': toast(ev.text); break;
      case 'error': toast(ev.message, 'err'); break;
      case 'pong': break;
      default: break;
    }
  }

  function enterChat(ev) {
    if (state.phase === 'live') {           // reconnect: refresh list only
      state.reconnectAttempts = 0;
      state.rejoinTries = 0;
      renderMembers(ev.users);
      banner(false);
      setConn('online', ev.transport === 'poll' ? 'connected (basic mode)' : 'connected');
      els.headTransport.textContent = ev.transport === 'poll' ? 'basic mode' : 'realtime · live';
      return;
    }
    state.phase = 'live';
    state.reconnectAttempts = 0;
    state.users = ev.users || [];
    state.room = ev.room;

    document.title = `#${ev.room} · Connect`;
    els.sidebarRoom.textContent = ev.room;
    els.chatRoom.textContent = ev.room;
    els.emptyRoom.textContent = ev.room;
    els.meName.textContent = ev.you;
    els.meAvatar.textContent = initials(ev.you);
    els.meAvatar.style.background = avatarBg(ev.you);
    els.headTransport.textContent = (state.transport === 'ws' || ev.transport === 'ws') ? 'realtime · live' : 'basic mode';

    els.joinScreen.hidden = true;
    els.chatScreen.hidden = false;
    banner(false);
    setConn('online');

    els.messages.querySelectorAll('.msg, .sys, .day-sep').forEach((n) => n.remove());
    state.lastAuthor = null; state.lastTs = 0; state.lastDayKey = null; state.seen = new Set();
    (ev.history || []).forEach((m) => addMessage(m, { animate: false }));

    renderMembers(ev.users);
    renderTyping([]);
    els.emptyState.hidden = (ev.history || []).length > 0;
    scrollToBottom(false);
    setJoining(false);

    if (!window.matchMedia('(pointer: coarse)').matches) setTimeout(() => els.msgInput.focus(), 120);
    setUrl(`?room=${encodeURIComponent(ev.room)}`);
  }

  /* ------------------------------------------------------------------ */
  /* rendering: members & typing                                        */
  /* ------------------------------------------------------------------ */

  function renderMembers(users) {
    state.users = users || [];
    els.emptyState.hidden = state.phase !== 'live' || els.messages.querySelector('.msg');
    els.onlineCount.textContent = state.users.length;
    els.headCount.textContent = `${state.users.length} online`;
    els.memberList.textContent = '';

    for (const user of state.users) {
      const li = el('li');
      const av = el('span', 'avatar', initials(user.name));
      av.style.background = avatarBg(user.name);
      li.appendChild(av);
      li.appendChild(el('span', 'who', user.name));
      if (key(user.name) === key(state.name)) li.appendChild(el('span', 'tag', 'you'));
      else if (user.typing) {
        const dots = el('span', 'typing-dots');
        dots.append(el('i'), el('i'), el('i'));
        li.appendChild(dots);
      }
      els.memberList.appendChild(li);
    }
  }

  function renderTyping(names) {
    const others = (names || []).filter((n) => key(n) !== key(state.name));
    els.typingLine.textContent = '';
    if (!others.length) return;
    const label = others.length === 1
      ? `${others[0]} is typing`
      : others.length === 2 ? `${others[0]} and ${others[1]} are typing` : 'Several people are typing';
    els.typingLine.textContent = `${label}…`;
  }

  /* ------------------------------------------------------------------ */
  /* rendering: messages                                                */
  /* ------------------------------------------------------------------ */

  function addMessage(msg, { animate = true } = {}) {
    const atBottom = isAtBottom();

    if (msg.id) {                            // replays after a reconnect must not double-post
      if (state.seen.has(msg.id)) return;
      state.seen.add(msg.id);
    }

    if (msg.kind === 'system') {
      // our own "joined" line: only the very first entry should announce us
      if (state.phase === 'live' && msg.text && msg.text.startsWith(`${state.name} joined`)) return;
      const node = el('div', 'sys', msg.text);
      els.messages.appendChild(node);
      state.lastAuthor = null;
      afterAppend(true);
      return;
    }

    const own = key(msg.name) === key(state.name);
    const dk = dayKey(msg.ts);
    const startOfDay = dk !== state.lastDayKey;
    if (startOfDay) {
      state.lastDayKey = dk;
      els.messages.appendChild(el('div', 'day-sep', dayLabel(msg.ts)));
    }

    const grouped = !startOfDay && !own && state.lastAuthor === key(msg.name) && (msg.ts - state.lastTs) < GROUP_WINDOW;

    const row = el('div', `msg${own ? ' own' : ''}${grouped ? ' grouped' : ''}`);
    if (!animate) row.style.animation = 'none';

    const av = el('span', 'avatar', initials(msg.name));
    av.style.background = avatarBg(msg.name);
    row.appendChild(av);

    const wrap = el('div', 'bubble-wrap');
    const meta = el('div', 'msg-meta');
    meta.appendChild(el('span', 'author', own ? 'You' : msg.name));
    meta.appendChild(el('span', 'time', clock(msg.ts)));
    wrap.appendChild(meta);

    const trimmed = msg.text.replace(/\s/g, '');
    const emojiOnly = trimmed.length > 0 && trimmed.length <= 24 && EMOJI_ONLY.test(trimmed);
    const bubble = el('div', `bubble${emojiOnly ? ' emoji-only' : ''}`);
    renderRich(bubble, msg.text);
    wrap.appendChild(bubble);
    wrap.appendChild(el('span', 'hover-time', clock(msg.ts)));

    row.appendChild(wrap);
    els.messages.appendChild(row);

    state.lastAuthor = key(msg.name);
    state.lastTs = msg.ts;

    if (own || atBottom || !animate) afterAppend(true);
    else {
      state.unread += 1;
      updateJump();
      document.title = `(${state.unread}) ${state.baseTitle}`;
    }
    if (animate && !own) ping();
  }

  function afterAppend(scroll) {
    els.emptyState.hidden = !!els.messages.querySelector('.msg');
    if (scroll) scrollToBottom(true);
    else isAtBottom();
  }

  /* ------------------------------------------------------------------ */
  /* scrolling                                                          */
  /* ------------------------------------------------------------------ */

  const isAtBottom = () => els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 80;

  function scrollToBottom(smooth) {
    requestAnimationFrame(() => {
      els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      state.unread = 0;
      updateJump();
      document.title = state.baseTitle;
    });
  }

  function updateJump() {
    els.jumpBtn.hidden = state.unread === 0 || state.phase !== 'live';
    els.jumpCount.hidden = state.unread === 0;
    els.jumpCount.textContent = state.unread > 99 ? '99+' : String(state.unread);
  }

  els.messages.addEventListener('scroll', () => {
    state.atBottom = isAtBottom();
    if (state.atBottom && state.unread) { state.unread = 0; updateJump(); document.title = state.baseTitle; }
  }, { passive: true });

  els.jumpBtn.addEventListener('click', () => scrollToBottom(true));

  /* ------------------------------------------------------------------ */
  /* composer                                                           */
  /* ------------------------------------------------------------------ */

  const EMOJIS = [
    '😀','😂','🥹','😊','😍','😎','🤔','🙃','😴','🥳','😭','😅','😇','🤯','😤','🫡',
    '👍','👎','👏','🙌','🤝','🙏','💪','✌️','🤞','👋','🫶','💅','🦾','🧠','👀','🫂',
    '❤️','🔥','✨','🎉','🎊','💯','⭐','🌈','☀️','🌙','⚡','🚀','🎯','🏆','🍕','☕',
  ];

  function buildEmojiPanel() {
    for (const e of EMOJIS) {
      const b = el('button', null, e);
      b.type = 'button';
      b.addEventListener('click', () => insertEmoji(e));
      els.emojiPanel.appendChild(b);
    }
  }

  function insertEmoji(emoji) {
    const input = els.msgInput;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    input.selectionStart = input.selectionEnd = start + emoji.length;
    input.focus();
    autoGrow();
    onComposerInput();
  }

  function autoGrow() {
    const input = els.msgInput;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 148)}px`;
  }

  function updateCounter() {
    const len = els.msgInput.value.length;
    els.counter.hidden = len < MAX_TEXT * 0.75;
    els.counter.textContent = `${len} / ${MAX_TEXT}`;
    els.counter.classList.toggle('warn', len > MAX_TEXT * 0.95);
  }

  function onComposerInput() {
    const hasText = els.msgInput.value.trim().length > 0;
    els.sendBtn.disabled = !hasText;
    updateCounter();

    const now = Date.now();
    if (hasText) {
      if (!state.typingSent && now - state.typingThrottle > 900) {
        state.typingSent = true;
        state.typingThrottle = now;
        send({ type: 'typing', on: true }, '/api/typing');
      }
      clearTimeout(state.typingStopTimer);
      state.typingStopTimer = setTimeout(stopTyping, 2200);
    } else stopTyping();
  }

  function stopTyping() {
    clearTimeout(state.typingStopTimer);
    if (!state.typingSent) return;
    state.typingSent = false;
    send({ type: 'typing', on: false }, '/api/typing');
  }

  els.msgInput.addEventListener('input', () => { autoGrow(); onComposerInput(); });

  els.msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.composer.requestSubmit();
    }
  });

  els.msgInput.addEventListener('blur', stopTyping);

  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.msgInput.value.trim();
    if (!text) return;
    const ok = send({ type: 'message', text }, '/api/message');
    if (!ok) { toast('Not connected — message not sent.', 'err'); return; }
    els.msgInput.value = '';
    autoGrow();
    updateCounter();
    els.sendBtn.disabled = true;
    stopTyping();
    scrollToBottom(true);
  });

  els.emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    els.emojiPanel.hidden = !els.emojiPanel.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!els.emojiPanel.hidden && !els.emojiPanel.contains(e.target) && e.target !== els.emojiBtn) els.emojiPanel.hidden = true;
  });

  /* ------------------------------------------------------------------ */
  /* sidebar / room actions                                             */
  /* ------------------------------------------------------------------ */

  const inviteLink = () => `${location.origin}${location.pathname}?room=${encodeURIComponent(state.room)}`;

  /** Show the link in a selectable field — works even where the clipboard API is blocked. */
  function showInvite() {
    const url = inviteLink();
    els.inviteInput.value = url;
    els.inviteInput.title = url;
    els.invitePanel.hidden = false;
    els.inviteInput.focus();
    els.inviteInput.select();
    const ok = copyText(inviteLink());
    ok.then((copied) => {
      els.inviteHint.textContent = copied
        ? 'Link copied to your clipboard.'
        : 'Copy the link below and send it to a friend.';
    });
  }

  function hideInvite() {
    els.invitePanel.hidden = true;
    els.inviteInput.value = '';
  }

  els.copyBtn.addEventListener('click', showInvite);

  els.shareBtn.addEventListener('click', async () => {
    const data = { title: 'Connect', text: `Join my room “${state.room}” on Connect`, url: inviteLink() };
    if (navigator.share) { try { await navigator.share(data); return; } catch { /* cancelled or blocked */ } }
    showInvite();
  });

  els.inviteClose.addEventListener('click', hideInvite);
  els.inviteAgain.addEventListener('click', () => { copyText(inviteLink()).then((ok) => toast(ok ? 'Link copied!' : 'Clipboard blocked — select and copy manually.', ok ? '' : 'err')); });

  els.soundBtn.addEventListener('click', () => {
    state.sound = !state.sound;
    els.soundBtn.setAttribute('aria-pressed', String(state.sound));
    toast(state.sound ? 'Notification sound on' : 'Notification sound muted');
  });

  let leaveArmed = false;
  let leaveTimer = null;

  function disarmLeave() {
    leaveArmed = false;
    clearTimeout(leaveTimer);
    els.leaveBtn.textContent = 'Leave room';
    els.leaveBtn.removeAttribute('data-armed');
  }

  function leaveRoom() {
    if (state.transport === 'ws' && state.socket && state.socket.readyState === 1) {
      try { state.socket.send(JSON.stringify({ type: 'leave' })); } catch {}
    } else if (state.sessionId) {
      fetch('/api/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: state.sessionId }) }).catch(() => {});
    }
    state.phase = 'join';
    state.transport = null;
    hideInvite();
    clearTransports();
    state.lastSessionId = null;
    state.users = []; state.unread = 0;
    els.chatScreen.hidden = true;
    els.joinScreen.hidden = false;
    document.title = state.baseTitle;
    els.emptyState.hidden = false;
    els.messages.querySelectorAll('.msg, .sys, .day-sep').forEach((n) => n.remove());
    els.msgInput.value = '';
    autoGrow();
    updateCounter();
    updateJump();
    closeDrawer();
    setJoining(false);
    setUrl(location.pathname);
    setTimeout(() => els.roomInput.focus(), 120);
  }

  els.leaveBtn.addEventListener('click', () => {
    if (!leaveArmed) {                       // two-step confirm: avoids window.confirm()
      leaveArmed = true;
      els.leaveBtn.textContent = 'Confirm leave?';
      els.leaveBtn.setAttribute('data-armed', 'true');
      leaveTimer = setTimeout(disarmLeave, 4000);
      return;
    }
    disarmLeave();
    leaveRoom();
  });

  /* mobile drawer */
  const openDrawer = () => { els.sidebar.classList.add('open'); els.scrim.hidden = false; };
  const closeDrawer = () => { els.sidebar.classList.remove('open'); els.scrim.hidden = true; };
  els.drawerBtn.addEventListener('click', openDrawer);
  els.sidebarClose.addEventListener('click', closeDrawer);
  els.scrim.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.emojiPanel.hidden) els.emojiPanel.hidden = true;
      else closeDrawer();
    }
  });

  /* ------------------------------------------------------------------ */
  /* sound + misc                                                       */
  /* ------------------------------------------------------------------ */

  let audioCtx = null;
  function ping() {
    if (!state.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.exponentialRampToValueAtTime(1250, t + 0.1);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.06, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t); osc.stop(t + 0.24);
    } catch { /* audio blocked — ignore */ }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.phase === 'live') {
      if (state.unread) { state.unread = 0; updateJump(); document.title = state.baseTitle; }
    }
  });

  window.addEventListener('online', () => { if (state.phase === 'live' && !state.socket && state.transport !== 'poll') connectRealtime(); });
  window.addEventListener('beforeunload', () => { stopTyping(); });

  /* keep the socket warm through proxies */
  setInterval(() => {
    if (state.transport === 'ws' && state.socket && state.socket.readyState === 1) {
      try { state.socket.send(JSON.stringify({ type: 'ping' })); } catch {}
    }
  }, 20000);

  /* ------------------------------------------------------------------ */
  /* boot                                                               */
  /* ------------------------------------------------------------------ */

  buildEmojiPanel();
  initJoinScreen();
  els.sendBtn.disabled = true;
  updateJump();
})();
