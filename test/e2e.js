/**
 * End-to-end smoke test for Connect.
 * Boots nothing itself — expects the server on http://127.0.0.1:PORT (default 3000).
 *   node test/e2e.js
 *
 * Uses the hand-rolled client in test/ws-client-lite.js so the whole project
 * can be verified with no npm dependencies at all.
 */
const { WebSocketLite } = require('./ws-client-lite');

/** Adapter so the tests can keep the familiar ws-style API. */
function WebSocket(url) {
  const sock = new WebSocketLite(url);
  const wrappers = { message: [], close: [] };
  sock.on('message', (data) => wrappers.message.forEach((fn) => fn(data)));
  sock.on('close', () => wrappers.close.forEach((fn) => fn()));
  sock.on('error', () => { /* surfaced through close */ });
  return {
    _sock: sock,
    get readyState() { return sock.readyState === 1 ? 1 : 3; },
    on(evt, fn) { if (wrappers[evt]) wrappers[evt].push(fn); return this; },
    send(data) { return sock.send(data); },
    close() { sock.close(); },
  };
}
const PORT = process.env.PORT || 3000;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function socketClient(name, room, resume) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const events = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    events.push(msg);
    if (msg.type === 'hello') ws.send(JSON.stringify({ type: 'join', name, room, resume }));
  });
  return { ws, events, wait: (type, ms = 1500) => waitFor(events, type, ms) };
}

async function waitFor(events, type, ms = 1500, pred = null) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = [...events].reverse().find((e) => e.type === type && (!pred || pred(e)));
    if (hit) return hit;
    await sleep(25);
  }
  return null;
}

(async () => {
  console.log('\n── static + health ──');
  const health = await (await fetch(`${BASE}/health`)).json();
  check('GET /health ok', health.ok === true);

  const html = await (await fetch(`${BASE}/`)).text();
  check('serves index.html', html.includes('Enter Chat Room') && html.includes('Quick Tip'));

  const viaRoomPath = await fetch(`${BASE}/some/deep/link`);
  check('unknown path falls back to app shell', (await viaRoomPath.text()).includes('Connect'));

  const raw = require('net');
  const rawGet = (target) => new Promise((resolve) => {
    const sock = raw.connect(PORT, '127.0.0.1', () => sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let buf = '';
    sock.on('data', (d) => { buf += d.toString(); });
    sock.on('close', () => resolve(buf.split('\r\n')[0]));
    sock.on('error', () => resolve('ERR'));
  });
  check('path traversal via /../ blocked', (await rawGet('/../server.js')).includes('403'));
  check('path traversal via %2e%2e blocked', (await rawGet('/%2e%2e/server.js')).includes('403'));
  check('no access to package.json', !/200/.test(await rawGet('/..%2fpackage.json')));

  console.log('\n── websocket flow ──');
  const a = socketClient('Haider', 'test-room');
  check('client A joined', !!(await a.wait('joined')));
  const joinedA = a.events.find((e) => e.type === 'joined');
  check('history starts empty', Array.isArray(joinedA.history) && joinedA.history.length === 0);
  check('own name echoed back', joinedA.you === 'Haider');

  const b = socketClient('Sara', 'test-room');
  const joinedB = await b.wait('joined');
  check('client B joined same room', !!joinedB && joinedB.room.toLowerCase() === 'test-room');

  await sleep(150);
  const aUsers = [...a.events].reverse().find((e) => e.type === 'users');
  const bJoinedUsers = joinedB.users.map((u) => u.name);
  check('B sees both members', bJoinedUsers.includes('Haider') && bJoinedUsers.includes('Sara'), JSON.stringify(bJoinedUsers));
  check('A notified of B joining', !!aUsers && aUsers.users.length === 2, JSON.stringify(aUsers && aUsers.users));
  check('join shows as system message', a.events.some((e) => e.type === 'message' && e.message.kind === 'system' && /Sara joined/.test(e.message.text)));

  console.log('\n── messaging ──');
  a.ws.send(JSON.stringify({ type: 'message', text: 'hey Sara! <script>alert(1)</script>' }));
  const gotByB = await waitFor(b.events, 'message', 1500, (e) => e.message.kind === 'user');
  check('B receives A\'s message', !!gotByB && gotByB.message.name === 'Haider');
  check('message text preserved verbatim (rendered as text on client)', gotByB.message.text.includes('<script>'));

  b.ws.send(JSON.stringify({ type: 'typing', on: true }));
  const typingEvt = await waitFor(a.events, 'typing');
  check('typing indicator relayed', !!typingEvt && typingEvt.users.includes('Sara'), JSON.stringify(typingEvt && typingEvt.users));

  console.log('\n── duplicate names & validation ──');
  const c = socketClient('haider', 'test-room');
  const dupErr = await c.wait('error');
  check('duplicate username rejected (case-insensitive)', !!dupErr && /already in room/i.test(dupErr.message));

  const junk = socketClient('x', 'test-room');
  const badName = await junk.wait('error');
  check('too-short username rejected', !!badName && /at least 2/i.test(badName.message));

  console.log('\n── rate limiting ──');
  for (let i = 0; i < 20; i++) a.ws.send(JSON.stringify({ type: 'message', text: `flood ${i}` }));
  await sleep(400);
  const rateErr = a.events.find((e) => e.type === 'error' && /slow down/i.test(e.message));
  check('flooding gets rate limited', !!rateErr);

  console.log('\n── history for late joiners ──');
  const d = socketClient('Late', 'test-room');
  const joinedD = await d.wait('joined');
  check('late joiner receives history', !!joinedD && joinedD.history.length > 0, `history=${joinedD && joinedD.history.length}`);
  check('history capped at 150', joinedD.history.length <= 150);

  console.log('\n── reconnect takeover ──');
  const stale = socketClient('Zed', 'rejoin-room');
  await stale.wait('joined');
  const staleId = stale.events.find((e) => e.type === 'hello').sessionId;
  const rejoin = socketClient('Zed', 'rejoin-room', staleId);
  await sleep(120);
  const rejoinMsg = await waitFor(rejoin.events, 'joined', 1500);
  check('same name can reconnect with its resume token', !!rejoinMsg, JSON.stringify(rejoin.events.filter(e => e.type === 'error')));
  const rejoinErr = rejoin.events.find((e) => e.type === 'error');
  check('reconnect is not rejected as duplicate', !rejoinErr || !/already in room/i.test(rejoinErr.message));

  const stranger = socketClient('Zed', 'rejoin-room');
  const strangerErr = await stranger.wait('error', 1500);
  check('a stranger still cannot steal a live name', !!strangerErr && /already in room/i.test(strangerErr.message));

  console.log('\n── rooms are isolated ──');
  const other = socketClient('Ghost', 'another-room');
  const joinedOther = await other.wait('joined');
  check('different room starts fresh', joinedOther.history.length === 0);
  check('different room has one member', joinedOther.users.length === 1);

  console.log('\n── leave & cleanup ──');
  d.ws.send(JSON.stringify({ type: 'leave' }));
  await sleep(200);
  const leftEvt = [...a.events].reverse().find((e) => e.type === 'message' && e.message.kind === 'system' && /Late left/.test(e.message.text));
  check('leave announced to the room', !!leftEvt);

  const beforeLeave = await (await fetch(`${BASE}/health`)).json();
  other.ws.send(JSON.stringify({ type: 'leave' }));
  await sleep(300);
  const afterLeave = await (await fetch(`${BASE}/health`)).json();
  check('empty room is garbage-collected', afterLeave.rooms === beforeLeave.rooms - 1,
        `before=${beforeLeave.rooms} after=${afterLeave.rooms}`);

  console.log('\n── http polling fallback ──');
  const j1 = await (await fetch(`${BASE}/api/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Poller', room: 'poll-room' }),
  })).json();
  check('poll client joins over HTTP', j1.ok === true && typeof j1.sessionId === 'string');

  const j2 = await (await fetch(`${BASE}/api/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Poller2', room: 'poll-room' }),
  })).json();

  const pollFirst = await (await fetch(`${BASE}/api/poll?id=${j1.sessionId}&after=0`)).json();
  check('poll returns join payload', pollFirst.events.some((e) => e.type === 'joined'));
  const cursor = pollFirst.seq;

  await fetch(`${BASE}/api/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: j2.sessionId, text: 'hello over http' }),
  });

  const pollSecond = await (await fetch(`${BASE}/api/poll?id=${j1.sessionId}&after=${cursor}`)).json();
  const newMsgs = pollSecond.events.filter((e) => e.type === 'message');
  check('poll delivers new message', newMsgs.some((e) => e.message.kind === 'user' && e.message.text === 'hello over http'));
  check('cursor advances (no replay)', newMsgs.filter((e) => e.message.kind === 'user').length === 1, `newMsgs=${newMsgs.length}`);

  await fetch(`${BASE}/api/leave`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: j1.sessionId }) });
  const afterLeavePoll = await (await fetch(`${BASE}/api/poll?id=${j1.sessionId}&after=0`)).json();
  check('session invalidated after leave', afterLeavePoll.ok === false);

  [a.ws, b.ws, c.ws, junk.ws, other.ws, stale.ws, rejoin.ws, stranger.ws].forEach((ws) => { try { ws.close(); } catch {} });

  console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error('test crashed:', err); process.exit(1); });
