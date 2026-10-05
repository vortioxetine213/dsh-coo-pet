/**
 * 开发用的独立启动器:不起 DSH,只验证「服务器 + Coopanion 的 pet-host 窗口 + 气泡」这条链路。
 *
 * 用法:
 *   node dev/serve.mjs                 # 起窗口,连上后打个招呼
 *   node dev/serve.mjs --say=你好      # 连上后说指定的一句
 *   node dev/serve.mjs --no-window     # 只起服务器(在浏览器里开 /pet 看)
 *
 * 另外在控制端口(默认 17899)上开一条 `/say?text=...&actions=wave,happy` 的调试入口,
 * 方便随时让桌宠开口,不用重启。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { findCooRoot, ensureAssets } from '../lib/assets.mjs';
import { PetServer } from '../lib/pet-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DATA_DIR = join(ROOT, 'data');

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => process.argv.includes(`--${name}`);

// 页面素材不在仓库里:和插件一样,从用户装好的 Coopanion 里取
const COO_ROOT = findCooRoot(arg('coo-root', null));
if (!COO_ROOT) {
  console.error('找不到 Coopanion 的安装目录,可以用 --coo-root=<目录> 指定');
  process.exit(1);
}
mkdirSync(DATA_DIR, { recursive: true });
const ASSETS = ensureAssets({ cooRoot: COO_ROOT, destDir: DATA_DIR, log: (m) => console.log(`[assets] ${m}`) });
if (!ASSETS.ok) {
  console.error(ASSETS.reason);
  process.exit(1);
}
const WEB_DIR = ASSETS.webDir;
/** pet-host 所在的 Coopanion 安装目录;可用 --exe= 覆盖。 */
const DEFAULT_EXE = arg('exe', join(COO_ROOT, 'Coopanion.exe'));

const GREETING = arg('say', '主人,本鲸上桌啦。双击人家,或者在人家身上悬停点「打字」,就能跟本鲸说话。');
const CONTROL_PORT = Number(arg('control-port', '17899'));
const EXE = arg('exe', DEFAULT_EXE);
const NO_WINDOW = has('no-window');
/** 给了就让 pet-host 开 CDP,便于 dev/inspect.mjs 问页面内部状态。 */
const DEBUG_PORT = arg('debug-port', null);

/** 桌宠当前的样子:那只 DeepSeek 配色的鲸鱼女仆。 */
const SKIN = {
  figure: 'whale',
  scheme: 'deepseek',
  palette: 'mint',
  head: 'none',
  side: 'none',
  glasses: 'none',
  neck: 'none',
  colors: {
    head: { main: 'body', acc: 'eye' },
    side: { main: 'eye', acc: 'eye' },
    glasses: { main: 'body', acc: 'eye' },
    neck: { main: 'eye', acc: 'eye' },
  },
};

/** 页面的 init 快照;字段与 cortico-world-desktop-pet 的 snapshot() 一致。 */
function snapshot() {
  return {
    skin: SKIN,
    roam: 'free',
    sound: false,
    sounds: {},
    theme: 'dark',
    rememberPosition: false,
    startX: null,
    hoverButtons: ['chat'],
    doubleClickChat: true,
    scale: 2,
    lockFrameRate: true,
    user: '主人',
    mic: false,
    voice: { enabled: false, ready: false, detail: '识别服务没有运行', hint: '', mode: 'always', key: '' },
    micDevice: '',
    thinking: false,
    bot: {
      name: '鲸鲸',
      avatar: null,
      controls: false,
      buttons: { pause: false, settings: false, dress: false, quit: false },
      paused: null,
      quitLabel: '',
      quitPrompt: '',
    },
  };
}

let said = false;
let seq = 0;
const server = new PetServer({
  webDir: WEB_DIR,
  port: 0,
  snapshot,
  onConnect: () => {
    console.log('[pet] 桌宠页面已连接');
    if (!said) {
      said = true;
      setTimeout(() => say(GREETING, ['wave']), 800);
    }
  },
  onDisconnect: () => console.log('[pet] 桌宠页面断开'),
  onMessage: (msg) => {
    if (msg.t === 'hello') console.log('[pet] hello', JSON.stringify(msg.screen ?? {}));
    else if (msg.t === 'text') console.log(`\n>>> 主人说:${msg.text}\n`);
    else if (msg.t === 'touch') console.log(`[pet] 触摸 ${msg.kind}${msg.count ? ` ×${msg.count}` : ''}`);
    else if (msg.t === 'figure') console.log(`[pet] 形象 ${msg.id} ok=${msg.ok} ${msg.reason ?? ''}`);
    else if (msg.t === 'position') console.log(`[pet] 位置 x=${msg.x}`);
    else console.log('[pet]', JSON.stringify(msg));
  },
});

/** 让桌宠说话:`beats` 里每一条是打字显示的一段,actions 是同时做的动作。 */
function say(text, actions = ['happy']) {
  const id = `s${++seq}`;
  const ok = server.send({ t: 'say', id, beats: [{ text, actions, anchors: [] }] });
  console.log(`[say] ${ok ? '已发出' : '没连上'} #${id} ${text}`);
  return ok;
}

await server.start();
console.log(`[srv] 桌宠服务器 ${server.origin}  (页面 ${server.petUrl})`);

/* ---------- 调试控制口:随时让桌宠说话 / 看状态 ---------- */
const control = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const text = url.searchParams.get('text');
  if (url.pathname === '/say' && text) {
    const actions = (url.searchParams.get('actions') ?? 'happy').split(',').map((s) => s.trim()).filter(Boolean);
    const ok = say(text, actions);
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok, connected: server.connected }));
    return;
  }
  if (url.pathname === '/state') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ connected: server.connected, url: server.petUrl, port: server.port }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => control.listen(CONTROL_PORT, '127.0.0.1', r));
console.log(`[ctl] 调试口 http://127.0.0.1:${CONTROL_PORT}/say?text=你好  (状态 /state)`);

/* ---------- 桌宠窗口 ---------- */
let child = null;
if (!NO_WINDOW) {
  if (!EXE) {
    console.log('[host] 没给 --exe,只起服务器');
  } else {
    console.log(`[host] 拉起桌宠窗口:${EXE} --pet-host --pet-url=${server.petUrl}`);
    // DSH 自己是 Electron,给子进程留了 ELECTRON_RUN_AS_NODE=1;
    // 桌宠窗口必须按 Electron 起,否则 Coopanion.exe 以 Node 模式解析 --pet-host,报 bad option
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    // 用自己的数据目录:Coopanion 默认把 pet-host 的 profile 放在 <安装目录>\data\pet-window,
    // 而主人自己那套 Coopanion 正在用同一个目录。两个进程抢同一个 GPU 缓存目录时,
    // 后起的那个 WebGL 起不来,鲸鱼就画不出来了。
    env.CORTICO_COMPANION_DATA = join(ROOT, 'data');
    const args = ['--pet-host', `--pet-url=${server.petUrl}`, `--parent-pid=${process.pid}`];
    // 调试时用 CDP 问页面:node dev/inspect.mjs "表达式"
    if (DEBUG_PORT) args.push(`--remote-debugging-port=${DEBUG_PORT}`);
    child = spawn(EXE, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });
    child.stdout.on('data', (d) => process.stdout.write(`[host] ${d}`));
    child.stderr.on('data', (d) => process.stdout.write(`[host:err] ${d}`));
    child.on('exit', (code) => console.log(`[host] 桌宠窗口退出 code=${code}`));
  }
}

const shutdown = async () => {
  console.log('\n[bye] 收摊');
  child?.kill();
  await server.stop().catch(() => {});
  control.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
