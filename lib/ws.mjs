/**
 * 零依赖 WebSocket 服务端(RFC 6455 服务端侧)。
 *
 * 桌宠页面只用到这几种帧:文本(协议 JSON)、二进制(16 kHz 麦克风 PCM)、
 * ping/pong、close。分片消息按协议拼回去。
 *
 * 自己写而不是装 `ws`,是为了让插件自包含:装包会让 pnpm 往 C 盘写 store,
 * 而这里全部落在 D 盘。
 */
import { createHash } from 'node:crypto';

/** 握手用的固定 GUID(RFC 6455 §1.3)。 */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 单帧载荷上限;页面只会发几十 KB 的音频块,超过这个数一定是出了问题。 */
const MAX_PAYLOAD = 8 * 1024 * 1024;

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/**
 * 一条已握手的连接。
 *
 * `onMessage(fn)` 收到 `(data, isBinary)`:文本帧是 string,二进制帧是 Buffer。
 * `onClose(fn)` 只触发一次,`open` 之后一直是 false。
 */
export class WebSocketConnection {
  constructor(socket, head) {
    this.socket = socket;
    this.open = true;
    this.buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.messageHandlers = [];
    this.closeHandlers = [];
    /** 分片消息:首帧的操作码,以及已经收到的分片。 */
    this.fragOp = 0;
    this.frags = [];
    this.fragLen = 0;
    socket.setNoDelay?.(true);
    socket.on('data', (chunk) => {
      if (!this.open) return;
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      try {
        this.drain();
      } catch {
        this.destroy();
      }
    });
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    // 握手请求可能已经把首帧带进来了;等调用方挂好回调再解析
    queueMicrotask(() => {
      try {
        this.drain();
      } catch {
        this.destroy();
      }
    });
  }

  onMessage(fn) {
    this.messageHandlers.push(fn);
  }

  onClose(fn) {
    this.closeHandlers.push(fn);
  }

  /** 发一帧;字符串走文本帧,其余走二进制帧。连接已关时静默丢弃。 */
  send(data) {
    if (!this.open) return false;
    const isText = typeof data === 'string';
    this.frame(isText ? OP_TEXT : OP_BIN, Buffer.from(data));
    return true;
  }

  /** 正常关闭:发 close 帧再关 TCP,理由尽量带给对端。 */
  close(code = 1000, reason = '') {
    if (!this.open) return;
    const tail = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const payload = Buffer.allocUnsafe(2 + tail.length);
    payload.writeUInt16BE(code, 0);
    tail.copy(payload, 2);
    this.frame(OP_CLOSE, payload);
    try {
      this.socket.end();
    } catch {
      /* 已经断了 */
    }
  }

  /** 出错时立刻掐断,不走挥手。 */
  destroy() {
    try {
      this.socket.destroy();
    } catch {
      /* 已经断了 */
    }
    this.finish();
  }

  finish() {
    if (!this.open) return;
    this.open = false;
    this.frags = [];
    for (const fn of this.closeHandlers.splice(0)) {
      try {
        fn();
      } catch {
        /* 回调自己的错不该影响别的连接 */
      }
    }
  }

  /** 把缓冲区里完整的帧全部解析出来。 */
  drain() {
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) {
          this.close(1009, 'frame too large');
          return;
        }
        len = Number(big);
        off = 10;
      }
      if (len > MAX_PAYLOAD) {
        this.close(1009, 'frame too large');
        return;
      }
      let mask = null;
      if (masked) {
        if (b.length < off + 4) return;
        mask = b.subarray(off, off + 4);
        off += 4;
      }
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      this.buf = b.subarray(off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.accept(fin, op, payload);
    }
  }

  /** 一帧:控制帧就地处理,数据帧按分片规则拼起来再投递。 */
  accept(fin, op, payload) {
    if (op === OP_CLOSE) {
      this.close(1000, '');
      // 对端已经要走,给它一点时间把 close 帧读完
      setTimeout(() => this.destroy(), 200);
      return;
    }
    if (op === OP_PING) {
      this.frame(OP_PONG, payload);
      return;
    }
    if (op === OP_PONG) return;
    if (op === OP_TEXT || op === OP_BIN) {
      if (fin) return this.deliver(op, payload);
      this.fragOp = op;
      this.frags = [payload];
      this.fragLen = payload.length;
      return;
    }
    if (op === OP_CONT) {
      if (!this.fragOp) return; // 没有开头就来的续帧:忽略
      this.fragLen += payload.length;
      if (this.fragLen > MAX_PAYLOAD) {
        this.close(1009, 'message too large');
        return;
      }
      this.frags.push(payload);
      if (fin) {
        const whole = Buffer.concat(this.frags, this.fragLen);
        const first = this.fragOp;
        this.frags = [];
        this.fragOp = 0;
        this.fragLen = 0;
        this.deliver(first, whole);
      }
    }
  }

  deliver(op, payload) {
    const data = op === OP_TEXT ? payload.toString('utf8') : payload;
    const isBinary = op === OP_BIN;
    for (const fn of this.messageHandlers) {
      try {
        fn(data, isBinary);
      } catch {
        /* 一个回调出错不该拖垮连接 */
      }
    }
  }

  /** 服务端发出的帧一律不掩码(客户端掩码,服务端不掩码)。 */
  frame(op, payload) {
    if (!this.open) return;
    const len = payload.length;
    let head;
    if (len < 126) {
      head = Buffer.allocUnsafe(2);
      head[1] = len;
    } else if (len < 65536) {
      head = Buffer.allocUnsafe(4);
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.allocUnsafe(10);
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    head[0] = 0x80 | op;
    try {
      this.socket.write(head);
      if (len) this.socket.write(payload);
    } catch {
      this.finish();
    }
  }
}

/**
 * 处理 HTTP 升级请求;成功时返回连接,不是合法的 WebSocket 握手就销毁 socket 并返回 null。
 */
export function upgradeToWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  if (upgrade !== 'websocket' || typeof key !== 'string' || !key) {
    socket.destroy();
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WebSocketConnection(socket, head);
}
