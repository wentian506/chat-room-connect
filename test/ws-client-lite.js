/**
 * ws-client-lite — a minimal RFC 6455 client, used only by the test suite.
 * Lets the tests exercise the server without any npm dependencies.
 */
const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const OP = { CONT: 0x0, TEXT: 0x1, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function encodeClientFrame(opcode, payload, fin = true) {
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = (fin ? 0x80 : 0) | opcode;

  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

class WebSocketLite extends EventEmitter {
  constructor(url, { timeout = 4000 } = {}) {
    super();
    const u = new URL(url);
    this.readyState = 0;
    this._buf = Buffer.alloc(0);
    this._frags = [];
    this._fragOp = null;

    this.socket = net.connect(Number(u.port || 80), u.hostname, () => {
      const key = crypto.randomBytes(16).toString('base64');
      this._expectAccept = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      this.socket.write(
        `GET ${u.pathname || '/'} HTTP/1.1\r\n` +
        `Host: ${u.host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });

    this.socket.setTimeout(timeout, () => this.emit('error', new Error('connect timeout')));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => {
      this.readyState = 3;
      if (!this._closedEmitted) { this._closedEmitted = true; this.emit('close'); }
    });
    this.socket.on('data', (chunk) => this._onData(chunk));
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);

    if (this.readyState === 0) {
      const end = this._buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = this._buf.subarray(0, end).toString();
      this._buf = this._buf.subarray(end + 4);
      if (!/HTTP\/1\.1 101/.test(head)) return this.emit('error', new Error(`handshake failed: ${head.split('\r\n')[0]}`));
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
      if (accept !== this._expectAccept) return this.emit('error', new Error('bad Sec-WebSocket-Accept'));
      this.readyState = 1;
      this.socket.setTimeout(0);
      this.emit('open');
    }

    for (;;) {
      const buf = this._buf;
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) === 0x80;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) === 0x80;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
      if (masked) offset += 4;                                  // servers should not mask
      if (buf.length < offset + len) return;

      const payload = buf.subarray(offset, offset + len);
      this._buf = buf.subarray(offset + len);

      if (opcode === OP.CLOSE) { this.readyState = 2; this.socket.end(); return; }
      if (opcode === OP.PING) { this.send(payload, OP.PONG); continue; }
      if (opcode === OP.PONG) { this.emit('pong'); continue; }
      if (opcode === OP.CONT) { this._frags.push(payload); if (fin) this._complete(); continue; }
      if (fin) this.emit('message', payload.toString('utf8'));
      else { this._fragOp = opcode; this._frags = [payload]; }
    }
  }

  _complete() {
    const text = Buffer.concat(this._frags).toString('utf8');
    this._fragOp = null;
    this._frags = [];
    this.emit('message', text);
  }

  send(data, opcode = OP.TEXT) {
    if (this.readyState !== 1) return false;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    this.socket.write(encodeClientFrame(opcode, payload));
    return true;
  }

  close(code = 1000) {
    if (this.readyState !== 1) return;
    const body = Buffer.alloc(2);
    body.writeUInt16BE(code, 0);
    this.send(body, OP.CLOSE);
    this.readyState = 2;
    setTimeout(() => this.socket.destroy(), 300).unref?.();
  }
}

module.exports = { WebSocketLite, encodeClientFrame };
