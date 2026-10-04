/**
 * Connect — a realtime chat app.
 *
 * One process: static file server + WebSocket server + HTTP long-poll fallback.
 * No database, no accounts. Rooms live in memory and disappear when empty.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('./lib/ws-lite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const HISTORY_LIMIT = 150;      // messages kept per room
const OUTBOX_LIMIT = 400;       // events buffered per session (poll fallback)
const MAX_TEXT = 2000;          // characters per message
const MAX_NAME = 20;
const MAX_ROOM = 32;
const MAX_ROOMS = 500;
const RATE_WINDOW = 6000;       // ms
const RATE_MAX = 12;            // messages per window
const SESSION_TTL = 90_000;     // ms without activity before a poll session is reaped

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const rid = () => crypto.randomUUID();

function cleanName(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

function cleanRoom(raw) {
  return String(raw || '')
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ROOM);
}

const roomKey = (label) => label.toLowerCase();

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<string, Session>} */
const sessions = new Map();

function makeRoom(label) {
  const room = { key: roomKey(label), label, members: new Set(), history: [], typing: new Map() };
  rooms.set(room.key, room);
  return room;
}

function getRoom(label) {
  const key = roomKey(label);
  let room = rooms.get(key);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) {
      // recycle the emptiest room rather than refusing new traffic
      for (const [k, r] of rooms) {
        if (r.members.size === 0) { rooms.delete(k); break; }
      }
    }
    room = makeRoom(label);
  }
  return room;
}

function makeSession(transport) {
  const s = {
    id: rid(),
    transport,            // 'ws' | 'poll'
    ws: null,
    name: null,
    roomKey: null,
    seq: 0,
    outbox: [],
    typing: false,
    lastSeen: Date.now(),
    msgTimes: [],
  };
  sessions.set(s.id, s);
  return s;
}

/** Push an event to a session: straight down the socket, and buffered for pollers. */
function emit(session, payload) {
  const event = { ...payload, seq: ++session.seq };
  session.outbox.push(event);
  if (session.outbox.length > OUTBOX_LIMIT) session.outbox.splice(0, session.outbox.length - OUTBOX_LIMIT);
  if (session.transport === 'ws' && session.ws && session.ws.readyState === 1) {
    try { session.ws.send(JSON.stringify(event)); } catch { /* socket died; close handler cleans up */ }
  }
  return event;
}

const roomOf = (session) => (session.roomKey ? rooms.get(session.roomKey) : null);

function membersOf(room) {
  const list = [];
  for (const id of room.members) {
    const s = sessions.get(id);
    if (s) list.push({ name: s.name, typing: s.typing });
  }
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return list;
}

function broadcast(room, payload, { except = null } = {}) {
  for (const id of room.members) {
    const s = sessions.get(id);
    if (!s || s === except) continue;
    emit(s, payload);
  }
}

function pushToRoom(room, payload) {
  if (room.members.size === 0) return;
  broadcast(room, payload);
}

function system(room, text) {
  const msg = { id: rid(), kind: 'system', text, ts: Date.now() };
  room.history.push(msg);
  if (room.history.length > HISTORY_LIMIT) room.history.splice(0, room.history.length - HISTORY_LIMIT);
  pushToRoom(room, { type: 'message', message: msg });
}

function overlay(room, text) {
  // transient system note — not stored in history
  pushToRoom(room, { type: 'notice', text, ts: Date.now() });
}

/* ------------------------------------------------------------------ */
/* room lifecycle                                                      */
/* ------------------------------------------------------------------ */

/** A member whose connection is clearly gone (socket dead, or poller vanished). */
function isStale(s) {
  if (!s) return true;
  if (s.transport === 'ws') return !(s.ws && s.ws.readyState === 1);
  return Date.now() - s.lastSeen > 25_000;
}

function join(session, rawName, rawRoom, resumeId = null) {
  if (session.roomKey) return { ok: false, error: 'Already in a room.' };

  const name = cleanName(rawName);
  const label = cleanRoom(rawRoom);

  if (name.length < 2) return { ok: false, error: 'Pick a username with at least 2 characters.' };
  if (label.length < 1) return { ok: false, error: 'Room ID is required.' };
  if (!rooms.has(roomKey(label)) && rooms.size >= MAX_ROOMS) {
    return { ok: false, error: 'Server is at capacity. Try again shortly.' };
  }

  // --- reconnect: take over the caller's own previous session -------------
  // Session ids are unguessable UUIDs, and the name must match, so this only
  // ever reclaims the caller's own seat.
  let resumed = false;
  const resume = resumeId ? sessions.get(resumeId) : null;
  if (resume && resume !== session && resume.name && resume.name.toLowerCase() === name.toLowerCase()) {
    resumed = !!resume.roomKey;
    destroySession(resume);          // may leave the room empty and delete it
  }

  // resolve the room *after* any eviction, so we never hold a discarded object
  const room = getRoom(label);

  // --- otherwise evict a same-named member only if that connection is dead --
  if (!resumed) {
    for (const id of [...room.members]) {
      const other = sessions.get(id);
      if (!other || other.name.toLowerCase() !== name.toLowerCase()) continue;
      if (isStale(other)) destroySession(other);
      else return { ok: false, error: `"${name}" is already in room ${room.label}. Pick another name.` };
    }
  }
  if (room !== rooms.get(room.key)) return { ok: false, error: 'Room closed. Try again.' };

  session.name = name;
  session.roomKey = room.key;
  session.lastSeen = Date.now();
  room.members.add(session.id);

  emit(session, {
    type: 'joined',
    you: name,
    room: room.label,
    roomKey: room.key,
    history: room.history,
    users: membersOf(room),
    transport: session.transport,
    resumed,
  });

  if (resumed) overlay(room, `${name} reconnected`);
  else system(room, `${name} joined the room`);

  broadcast(room, { type: 'users', users: membersOf(room) }, { except: session });
  return { ok: true, room: room.label };
}

function sendMessage(session, rawText) {
  const room = roomOf(session);
  if (!room) return { ok: false, error: 'Not in a room.' };

  const now = Date.now();
  session.msgTimes = session.msgTimes.filter((t) => now - t < RATE_WINDOW);
  if (session.msgTimes.length >= RATE_MAX) {
    return { ok: false, error: 'Whoa — slow down a little.' };
  }

  const text = String(rawText || '').replace(/\r\n?/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, MAX_TEXT);
  if (!text) return { ok: false, error: 'Empty message.' };

  session.msgTimes.push(now);
  session.lastSeen = now;

  const msg = { id: rid(), kind: 'user', name: session.name, text, ts: now };
  room.history.push(msg);
  if (room.history.length > HISTORY_LIMIT) room.history.splice(0, room.history.length - HISTORY_LIMIT);

  if (session.typing) setTyping(session, false, { silent: true });
  pushToRoom(room, { type: 'message', message: msg });
  return { ok: true, id: msg.id };
}

function setTyping(session, isTyping, { silent = false } = {}) {
  const room = roomOf(session);
  if (!room) return;
  const next = Boolean(isTyping);
  if (session.typing === next) return;
  session.typing = next;
  session.lastSeen = Date.now();
  broadcast(room, {
    type: 'typing',
    users: membersOf(room).filter((u) => u.typing).map((u) => u.name),
  }, { except: session });
}

function leave(session, { announce = true } = {}) {
  const room = roomOf(session);
  session.typing = false;
  if (!room) return;
  room.members.delete(session.id);
  room.typing.delete(session.name);

  if (announce && room.members.size > 0) {
    system(room, `${session.name} left`);
    broadcast(room, { type: 'users', users: membersOf(room) });
    broadcast(room, { type: 'typing', users: membersOf(room).filter((u) => u.typing).map((u) => u.name) });
  }
  session.roomKey = null;
  session.name = null;
  session.typing = false;

  // rooms are ephemeral: drop the whole thing once nobody is inside
  if (room.members.size === 0 && rooms.get(room.key) === room) rooms.delete(room.key);
}

function destroySession(session) {
  leave(session);
  sessions.delete(session.id);
  if (session.ws) {
    try { session.ws.close(1000, 'replaced'); } catch {}
    session.ws = null;
  }
}

/* ------------------------------------------------------------------ */
/* static files                                                        */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // unknown paths fall through to the app shell (nice URLs + ?room= links)
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) return send(res, 404, 'Not found');
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  });
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req, limit = 32_768) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* http server                                                         */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const p = url.pathname;

  try {
    if (p === '/health') {
      const online = [...rooms.values()].reduce((n, r) => n + r.members.size, 0);
      return send(res, 200, JSON.stringify({ ok: true, rooms: rooms.size, online, uptime: process.uptime() }), MIME['.json']);
    }

    if (p === '/api/join' && req.method === 'POST') {
      const body = await readJson(req);
      const session = makeSession('poll');
      const result = join(session, body.name, body.room, body.resume);
      if (!result.ok) { sessions.delete(session.id); return send(res, 200, JSON.stringify(result), MIME['.json']); }
      return send(res, 200, JSON.stringify({ ok: true, sessionId: session.id }), MIME['.json']);
    }

    if (url.pathname.startsWith('/api/')) {
      // the session id travels in the query string (GET) or the JSON body (POST)
      const body = req.method === 'POST' ? await readJson(req) : {};
      const sessionId = url.searchParams.get('id') || body.id || '';
      const session = sessions.get(sessionId);
      if (!session) return send(res, 200, JSON.stringify({ ok: false, error: 'session expired' }), MIME['.json']);

      if (p === '/api/poll' && req.method === 'GET') {
        session.lastSeen = Date.now();
        const after = Number(url.searchParams.get('after') || 0) || 0;
        const events = session.outbox.filter((e) => e.seq > after);
        return send(res, 200, JSON.stringify({ ok: true, events, seq: session.seq }), MIME['.json']);
      }

      if (p === '/api/message' && req.method === 'POST') {
        return send(res, 200, JSON.stringify(sendMessage(session, body.text)), MIME['.json']);
      }

      if (p === '/api/typing' && req.method === 'POST') {
        setTyping(session, body.on);
        return send(res, 200, JSON.stringify({ ok: true }), MIME['.json']);
      }

      if (p === '/api/leave' && req.method === 'POST') {
        leave(session);
        sessions.delete(session.id);
        return send(res, 200, JSON.stringify({ ok: true }), MIME['.json']);
      }

      return send(res, 404, JSON.stringify({ ok: false, error: 'unknown endpoint' }), MIME['.json']);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res);
  } catch (err) {
    return send(res, 400, JSON.stringify({ ok: false, error: err.message }), MIME['.json']);
  }
});

/* ------------------------------------------------------------------ */
/* websocket transport                                                 */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  const session = makeSession('ws');
  session.ws = ws;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; session.lastSeen = Date.now(); });

  ws.on('message', (raw) => {
    session.lastSeen = Date.now();
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.type) {
      case 'join': {
        const result = join(session, msg.name, msg.room, msg.resume);
        if (!result.ok) emit(session, { type: 'error', message: result.error, fatal: true });
        break;
      }
      case 'message': {
        const result = sendMessage(session, msg.text);
        if (!result.ok && result.error !== 'Empty message.') emit(session, { type: 'error', message: result.error });
        break;
      }
      case 'typing': setTyping(session, msg.on); break;
      case 'leave': destroySession(session); ws.close(1000, 'left'); break;
      case 'ping': emit(session, { type: 'pong', ts: Date.now() }); break;
      default: break;
    }
  });

  ws.on('close', () => destroySession(session));
  ws.on('error', () => { try { ws.terminate(); } catch {} });

  emit(session, { type: 'hello', transport: 'ws', sessionId: session.id, ts: Date.now() });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.transport === 'poll' && now - s.lastSeen > SESSION_TTL) destroySession(s);
  }
}, 30_000);
heartbeat.unref?.();

/* ------------------------------------------------------------------ */

server.listen(PORT, HOST, () => {
  console.log(`Connect running on http://${HOST}:${PORT}  (ws:// + http fallback)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} received — shutting down.`);
    clearInterval(heartbeat);
    for (const ws of wss.clients) { try { ws.close(1001, 'server shutting down'); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

module.exports = { server, rooms, sessions };
