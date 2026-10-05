/**
 * 通过 CDP 问桌宠页面内部的状态(开发用)。
 *
 * 前提:serve.mjs 带了 `--debug-port=9333`(它会把它转给 pet-host 的 --remote-debugging-port)。
 *
 * 用法:
 *   node dev/inspect.mjs "innerWidth + 'x' + innerHeight"
 *   node dev/inspect.mjs --list
 */
const args = process.argv.slice(2);
const port = (() => {
  const hit = args.find((a) => a.startsWith('--port='));
  return hit ? Number(hit.slice(7)) : 9333;
})();
const expr = args.find((a) => !a.startsWith('--'));
/** --screenshot=<文件>:让 CDP 把页面画出来存成 PNG(先铺一层浅灰底,免得透明看不出来)。 */
const shot = (() => {
  const hit = args.find((a) => a.startsWith('--screenshot='));
  return hit ? hit.slice('--screenshot='.length) : null;
})();

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const pages = targets.filter((t) => t.type === 'page');
if (args.includes('--list')) {
  for (const p of pages) console.log(`${p.title}\t${p.url}\t${p.webSocketDebuggerUrl}`);
  process.exit(0);
}
const page = pages.find((p) => p.url.includes('/pet')) ?? pages[0];
if (!page) {
  console.error('没有可调试的页面');
  process.exit(1);
}
if (!expr && !shot) {
  console.log(`${page.title}\t${page.url}`);
  process.exit(0);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
});
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(msg.error.message));
  else slot.resolve(msg.result);
});

if (expr) {
  const result = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const value = result?.result?.value;
  if (result?.exceptionDetails) console.log('异常:', result.exceptionDetails.text, result.exceptionDetails.exception?.description ?? '');
  else console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

if (shot) {
  // 透明窗口直接截是一张全透明图:先铺底色,再画
  await call('Runtime.evaluate', { expression: "document.documentElement.style.background='#3a3f4b'; document.body.style.background='#3a3f4b';" });
  await new Promise((r) => setTimeout(r, 400));
  // fromSurface 对透明置顶窗口会挂住;从渲染器抓(raster)才拿得到 iframe 里 WebGL 画的那只鲸鱼
  const { data } = await call('Page.captureScreenshot', { format: 'png', fromSurface: false, captureBeyondViewport: false });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(shot, Buffer.from(data, 'base64'));
  console.log(`截图已存 ${shot}`);
  await call('Runtime.evaluate', { expression: "document.documentElement.style.background=''; document.body.style.background='';" });
}
ws.close();

