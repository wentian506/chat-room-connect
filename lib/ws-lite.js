/**
 * ws-lite — a small, dependency-free WebSocket server (RFC 6455).
 *
 * Only what Connect needs: text frames, fragmentation, ping/pong, close
 * handshake, masking enforcement and a payload cap. Roughly 200 lines, so the
 * whole app runs with `node server.js` and zero `npm install`.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const READY = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

const EMPTY = Buffer.alloc(0);

/** Build one frame. Server frames are never masked. */
function encodeFrame(opcode, payload = EMPTY, fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  return Buffer.concat([header, payload]);
}

class WebSocket extends EventEmitter {
  constructor(socket, { maxPayload = 1 << 20 } = {}) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.readyState = READY.OPEN;

    this._buf = EMPTY;
    this._fragOp = null;
    this._fragChunks = [];
    this._fragLen = 0;
    this._closed = false;

    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._emitError(err));
    socket.on('close', () => this._finish());
  }

  /* ---------------- outgoing ---------------- */

  send(data) {
    if (this.readyState !== READY.OPEN) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    return this._write(encodeFrame(OP.TEXT, payload));
  }

  ping(data = EMPTY) {
    if (this.readyState !== READY.OPEN) return false;
    return this._write(encodeFrame(OP.PING, Buffer.isBuffer(data) ? data : Buffer.from(String(data))));
  }

  pong(data = EMPTY) {
    if (this.readyState !== READY.OPEN) return false;
    return this._write(encodeFrame(OP.PONG, Buffer.isBuffer(data) ? data : Buffer.from(String(data))));
  }

  /** Graceful close: send the close frame, then let the peer answer (or time out). */
  close(code = 1000, reason = '') {
    if (this.readyState === READY.CLOSED) return;
    if (this.readyState === READY.OPEN) {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      this._write(encodeFrame(OP.CLOSE, body));
    }
    this.readyState = READY.CLOSING;
    const t = setTimeout(() => this.terminate(), 1000);
    t.unref?.();
    this._closeTimer = t;
  }

  terminate() {
    try { this.socket.destroy(); } catch { /* already gone */ }
    this._finish();
  }

  _write(frame) {
    if (this.socket.destroyed) return false;
    try { this.socket.write(frame); return true; } catch (err) { this._emitError(err); return false; }
  }

  /* ---------------- incoming ---------------- */

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;

    // A frame header is 2..14 bytes; loop while a whole frame is available.
    for (;;) {
      if (this._closed) return;
      const buf = this._buf;
      if (buf.length < 2) return;

      const fin = (buf[0] & 0x80) === 0x80;
      const rsv = buf[0] & 0x70;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) === 0x80;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (rsv !== 0) return this._fail(1002, 'reserved bits set');       // no extensions negotiated
      if (!masked) return this._fail(1002, 'client frames must be masked');

      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset);
        if (big > BigInt(this.maxPayload)) return this._fail(1009, 'payload too large');
        len = Number(big);
        offset += 8;
      }

      const isControl = (opcode & 0x8) !== 0;
      if (isControl && (!fin || len > 125)) return this._fail(1002, 'bad control frame');
      if (len > this.maxPayload) return this._fail(1009, 'payload too large');

      if (buf.length < offset + 4 + len) return;                        // wait for the rest
      const maskKey = buf.subarray(offset, offset + 4);
      offset += 4;

      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[offset + i] ^ maskKey[i & 3];
      this._buf = buf.subarray(offset + len);

      if (isControl) {
        if (opcode === OP.CLOSE) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
          this._write(encodeFrame(OP.CLOSE, payload.subarray(0, Math.min(payload.length, 125))));
          this.readyState = READY.CLOSING;
          this._closed = true;
          this.emit('close', code, reason);
          this.readyState = READY.CLOSED;
          clearTimeout(this._closeTimer);
          try { this.socket.end(); } catch { /* ignore */ }
          return;
        }
        if (opcode === OP.PING) { this.pong(payload); continue; }
        if (opcode === OP.PONG) { this.emit('pong', payload); continue; }
        return this._fail(1002, 'unknown control opcode');
      }

      if (opcode === OP.CONT) {
        if (this._fragOp === null) return this._fail(1002, 'continuation without start');
        this._fragChunks.push(payload);
        this._fragLen += payload.length;
        if (this._fragLen > this.maxPayload) return this._fail(1009, 'payload too large');
        if (fin) this._completeMessage(this._fragOp);
      } else if (opcode === OP.TEXT || opcode === OP.BINARY) {
        if (this._fragOp !== null) return this._fail(1002, 'new message inside a fragmented one');
        if (fin) {
          this.emit('message', opcode === OP.TEXT ? payload.toString('utf8') : payload, opcode === OP.BINARY);
        } else {
          this._fragOp = opcode;
          this._fragChunks = [payload];
          this._fragLen = payload.length;
        }
      } else {
        return this._fail(1002, 'unknown opcode');
      }
    }
  }

  _completeMessage(opcode) {
    const payload = Buffer.concat(this._fragChunks, this._fragLen);
    this._fragOp = null;
    this._fragChunks = [];
    this._fragLen = 0;
    this.emit('message', opcode === OP.TEXT ? payload.toString('utf8') : payload, opcode === OP.BINARY);
  }

  _fail(code, reason) {
    if (this.readyState === READY.OPEN) {
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      this._write(encodeFrame(OP.CLOSE, body));
    }
    this._closed = true;
    this.readyState = READY.CLOSING;
    setTimeout(() => this.terminate(), 60).unref?.();
  }

  _emitError(err) {
    if (this._errored) return;
    this._errored = true;
    this.emit('error', err);
  }

  _finish() {
    if (this._finished) return;
    this._finished = true;
    clearTimeout(this._closeTimer);
    const was = this.readyState;
    this.readyState = READY.CLOSED;
    try { this.socket.destroy(); } catch { /* ignore */ }
    this.emit('close', 1006, was === READY.CLOSED ? 'closed' : 'connection lost');
  }
}

class WebSocketServer extends EventEmitter {
  constructor({ server, maxPayload = 1 << 20, path = null } = {}) {
    super();
    this.clients = new Set();
    this.maxPayload = maxPayload;
    this.path = path;

    server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
  }

  _handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    const version = req.headers['sec-websocket-version'];

    const reject = (code, message) => {
      try {
        socket.write(
          `HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
          `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`
        );
      } catch { /* ignore */ }
      socket.destroy();
    };

    if (upgrade !== 'websocket' || !key || version !== '13') {
      return reject(400, 'Expected a WebSocket upgrade (RFC 6455, version 13).');
    }
    if (this.path && !req.url.startsWith(this.path)) return reject(404, 'Not found');

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );

    const ws = new WebSocket(socket, { maxPayload: this.maxPayload });
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    if (head && head.length) socket.unshift(head);      // bytes that arrived with the handshake

    this.emit('connection', ws, req);
  }
}

module.exports = { WebSocketServer, WebSocket, encodeFrame, OP, READY };
