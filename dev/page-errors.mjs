/**
 * 重载桌宠页面,把**加载期**抛出的异常(含堆栈)抓出来(开发用)。
 *
 * 为什么需要它:窗口是全屏透明的,页面崩了之后桌面上就是"什么都没出现",
 * 而 pet-host 只会往 stderr 打一行 `Uncaught (in promise) TypeError: ...`,
 * 没有堆栈就没法定位。这个脚本通过 CDP 重载页面并订阅 `Runtime.exceptionThrown`。
 *
 * 前提:serve.mjs 带着 `--debug-port=9333` 在跑。
 *
 *   node dev/page-errors.mjs
 */
const port = (() => {
  const hit = process.argv.slice(2).find((a) => a.startsWith('--port='));
  return hit ? Number(hit.slice(7)) : 9333;
})();

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.filter((t) => t.type === 'page').find((p) => p.url.includes('/pet')) ?? targets.find((t) => t.type === 'page');
if (!page) {
  console.error('没有可调试的页面,serve.mjs 带 --debug-port 起了吗?');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++seq, method, params }));
const found = [];

const frames = (st) =>
  (st?.callFrames ?? [])
    .slice(0, 8)
    .map((f) => `      ${f.functionName || '(anon)'}  ${String(f.url).split('/').pop()}:${f.lineNumber + 1}`)
    .join('\n');

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    found.push(`${d.exception?.description ?? d.text}\n${frames(d.stackTrace)}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    found.push(`console.error: ${msg.params.args.map((a) => a.description ?? a.value).join(' ')}`);
  }
};

ws.onopen = () => {
  send('Runtime.enable');
  send('Page.enable');
  setTimeout(() => send('Page.reload', { ignoreCache: true }), 300);
};

setTimeout(() => {
  console.log(`页面: ${page.url}`);
  console.log(`抓到 ${found.length} 条错误:`);
  for (const f of found) console.log('---\n' + f);
  process.exit(0);
}, 9000);
