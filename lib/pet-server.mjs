/**
 * 桌宠页面的本地服务器。
 *
 * 只绑 127.0.0.1,并且只回答 Host 是回环名的请求(网页无法借 DNS 重绑定碰到它)。
 *
 * - `/pet`:桌宠页面本身。在 pet-host 的透明窗口里它就是桌面上那只鲸鱼。
 * - `/web/*`:页面素材(pet.html 引的 css/js、whale 形象包的全部贴图)。
 * - `/figure-frame`:形象包代码的沙箱 iframe,自带 CSP(不透明源),只许读本服务器的脚本与图片。
 * - `/api/figures`:可用的形象包清单;`/api/state`:当前状态的快照;`/api/avatar`:bot 头像。
 * - `/socket?role=pet|dress&host=window|tab`:一条活的桌宠连接,外加任意多条只看不改的页面。
 *   桌宠连接发来的二进制帧是 16 kHz 单声道 PCM16 麦克风音频。
 *
 * 协议(与 cortico-world-desktop-pet 的 pages 一致):
 *   服务端→页面 {t:'init',...} / {t:'prefs',...} / {t:'say',id,beats} / {t:'ask',...}
 *              / {t:'dialog',...} / {t:'thinking',on} / {t:'walk'|'act'|'listen'|...}
 *   页面→服务端 {t:'hello',screen} / {t:'text',text} / {t:'touch',...} / {t:'answer',...}
 *              / {t:'dialog',...} / {t:'position',x} / {t:'figure',...} / {t:'prefs',...}
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { upgradeToWebSocket } from './ws.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** 页面路由:路径 → webDir 下的文件。 */
const PAGES = { '/pet': 'pet.html' };
/** 只认回环 Host,和原实现同一把门。 */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;
const PORT_ATTEMPTS = 10;
/** 窗口连接可以发的帧:无论来自哪个页面,这些输入都是人给的。 */
const WATCHER_MESSAGES = new Set(['text', 'prefs', 'control']);

const PAGE_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "img-src 'self' data:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self' http://127.0.0.1:* http://localhost:*",
].join('; ');

export class PetServer {
  /**
   * @param {object} opts
   * @param {string} opts.webDir 页面素材目录(本工程复制的 web/)
   * @param {() => Record<string, unknown>} opts.snapshot 新连接收到的 init 快照
   * @param {(msg: Record<string, unknown>) => void} [opts.onMessage] 桌宠页面发来的帧
   * @param {(pcm: Int16Array) => void} [opts.onAudio] 麦克风音频(二进制帧)
   * @param {() => void} [opts.onConnect] 桌宠页面连上
   * @param {() => void} [opts.onDisconnect] 桌宠页面断开
   * @param {number} [opts.port] 希望绑的端口;0 = 让系统给一个
   */
  constructor(opts) {
    this.opts = opts;
    this.http = null;
    this.pet = null;
    this.petIsWindow = false;
    this.watchers = new Set();
    this.boundPort = 0;
  }

  get port() {
    return this.boundPort;
  }

  get origin() {
    return this.boundPort ? `http://127.0.0.1:${this.boundPort}` : '';
  }

  get petUrl() {
    return this.origin ? `${this.origin}/pet` : '';
  }

  get connected() {
    return !!this.pet && this.pet.open;
  }

  async start() {
    const base = this.opts.port ?? 0;
    let lastErr = null;
    for (let i = 0; i < PORT_ATTEMPTS; i++) {
      const server = createServer((req, res) => {
        this.handle(req, res).catch(() => {
          try {
            res.writeHead(500).end();
          } catch {
            /* 头已经发出去了 */
          }
        });
      });
      try {
        await new Promise((done, fail) => {
          server.once('error', fail);
          server.listen(base === 0 ? 0 : base + i, '127.0.0.1', () => {
            server.off('error', fail);
            done();
          });
        });
      } catch (err) {
        lastErr = err;
        const code = err?.code;
        if (code === 'EADDRINUSE' || code === 'EACCES') continue;
        throw err;
      }
      this.http = server;
      const addr = server.address();
      this.boundPort = typeof addr === 'object' && addr ? addr.port : 0;
      server.on('upgrade', (req, socket, head) => {
        if (!this.allowed(req, true) || !(req.url ?? '').startsWith('/socket')) {
          socket.destroy();
          return;
        }
        const ws = upgradeToWebSocket(req, socket, head);
        if (ws) this.accept(ws, req);
      });
      return this.boundPort;
    }
    throw new Error(`端口 ${base}–${base + PORT_ATTEMPTS - 1} 都被占用:${lastErr?.message ?? ''}`);
  }

  async stop() {
    for (const ws of [this.pet, ...this.watchers]) ws?.close(1001, 'server stopping');
    this.pet = null;
    this.watchers.clear();
    const http = this.http;
    this.http = null;
    this.boundPort = 0;
    if (!http) return;
    http.closeAllConnections?.();
    await new Promise((r) => http.close(() => r()));
  }

  /** 发一帧给桌宠页面;没有页面时返回 false。 */
  send(msg) {
    if (!this.connected) return false;
    return this.pet.send(JSON.stringify(msg));
  }

  /** 发给桌宠页面和所有观战页面。 */
  broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of [this.pet, ...this.watchers]) if (ws?.open) ws.send(text);
  }

  /** 只许回环 Host;不透明源(形象沙箱)只能读。 */
  allowed(req, write) {
    if (!LOOPBACK.test(req.headers.host ?? '')) return false;
    const origin = req.headers.origin;
    if (origin === 'null') return !write;
    if (!origin) return true;
    try {
      return LOOPBACK.test(new URL(origin).host);
    } catch {
      return false;
    }
  }

  accept(ws, req) {
    const params = new URL(req.url ?? '/', 'http://x').searchParams;
    const fromWindow = params.get('host') === 'window';
    ws.send(JSON.stringify({ t: 'init', ...this.opts.snapshot() }));
    // 桌宠窗口压过一个浏览器标签页:窗口连着时,新开的标签页只看不改
    const watcher = params.get('role') !== 'pet' || (!fromWindow && this.connected && this.petIsWindow);
    if (!watcher) {
      const old = this.pet;
      this.pet = ws;
      this.petIsWindow = fromWindow;
      if (old) old.close(4000, 'replaced');
      this.opts.onConnect?.();
      ws.onMessage((data, isBinary) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (buf.length % 2 === 0) {
            // 复制一份:Int16Array 要 2 字节对齐,直接切 buffer 的 byteOffset 不保证对齐
            const pcm = new Int16Array(buf.length / 2);
            for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2);
            this.opts.onAudio?.(pcm);
          }
          return;
        }
        const msg = parse(data);
        if (msg) this.opts.onMessage?.(msg);
      });
      ws.onClose(() => {
        if (this.pet !== ws) return;
        this.pet = null;
        this.opts.onDisconnect?.();
      });
      return;
    }
    if (params.get('role') === 'pet') {
      ws.send(JSON.stringify({ t: 'watching' }));
      ws.onMessage((data, isBinary) => {
        const msg = isBinary ? null : parse(data);
        if (msg && WATCHER_MESSAGES.has(msg.t)) this.opts.onMessage?.(msg);
      });
    }
    this.watchers.add(ws);
    ws.onClose(() => this.watchers.delete(ws));
  }

  async handle(req, res) {
    if (!this.allowed(req, req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(421).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/api/figures') {
      return json(res, 200, this.figures());
    }
    if (req.method === 'GET' && path === '/api/state') {
      return json(res, 200, this.opts.snapshot());
    }
    if (req.method === 'GET' && path === '/api/avatar') {
      const file = this.opts.avatarFile;
      const bytes = file ? await readFile(file).catch(() => null) : null;
      if (!bytes) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache' }).end(bytes);
      return;
    }
    if (req.method === 'GET' && path === '/figure-frame') {
      const self = `http://${req.headers.host}`;
      return this.sendFile(res, join(this.opts.webDir, 'figure-frame.html'), [
        'sandbox allow-scripts',
        "default-src 'none'",
        `script-src ${self}`,
        `img-src ${self} data: blob:`,
        "style-src 'unsafe-inline'",
        "connect-src 'none'",
        `frame-ancestors ${self}`,
      ].join('; '));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (path === '/') {
      res.writeHead(302, { location: '/pet' }).end();
      return;
    }
    const file = PAGES[path] ?? (path.startsWith('/web/') ? path.slice(5) : null);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    const root = normalize(this.opts.webDir).replace(/[\\/]+$/, '') + sep;
    const full = normalize(join(root, file));
    if (!full.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    return this.sendFile(res, full, null, path.startsWith('/web/') && req.headers.origin === 'null');
  }

  /** 内置形象包清单:whale 的 figure.json 就在 web/whale/ 下。 */
  figures() {
    try {
      const m = JSON.parse(readFileSync(join(this.opts.webDir, 'whale', 'figure.json'), 'utf8'));
      return [{
        id: m.id,
        base: '/web/whale/',
        name: m.name,
        thumb: m.thumb ?? null,
        entry: m.entry,
        export: m.export,
        model: m.model ?? null,
        axes: m.axes,
        presets: m.presets,
      }];
    } catch {
      return [];
    }
  }

  /** 发一个文件;`csp` 不给就用页面的那条,`frame` 是形象沙箱的 CORS 请求。 */
  async sendFile(res, full, csp, frame = false) {
    try {
      const bytes = await readFile(full);
      res.writeHead(200, {
        'content-type': MIME[extname(full)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-security-policy': csp ?? PAGE_CSP,
        ...(frame ? { 'access-control-allow-origin': 'null' } : {}),
      });
      res.end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  }
}

function parse(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
