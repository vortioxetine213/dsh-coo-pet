/**
 * 模拟主人在桌宠身上打字(开发/验证用)。
 *
 * 连的是插件的桌宠服务器,用 `role=pet&host=tab` 开一条"只看"的连接——
 * 按 pet-server 的规矩,窗口连着时它不会顶掉窗口,但 `text` 这一类输入
 * 仍然是"人给的",会被当成主人在打字。
 *
 * 用法:node dev/poke.mjs "要说的话" [--port=62506]
 */
const args = process.argv.slice(2);
const text = args.find((a) => !a.startsWith('--')) ?? '有人在家吗?';
const port = (() => {
  const hit = args.find((a) => a.startsWith('--port='));
  return hit ? hit.slice(7) : '62506';
})();
const ws = new WebSocket(`ws://127.0.0.1:${port}/socket?role=pet&host=tab`);
let sent = false;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
ws.addEventListener('open', () => {
  log('连上桌宠服务器');
  ws.send(JSON.stringify({ t: 'hello', screen: { w: 1708, h: 1020 } }));
});
ws.addEventListener('message', (ev) => {
  let m = null;
  try {
    m = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  if (m.t === 'init') {
    log('收到 init,现在打字');
    sent = true;
    setTimeout(() => ws.send(JSON.stringify({ t: 'text', text })), 300);
    return;
  }
  if (m.t === 'say') {
    log('桌宠气泡:', (m.beats ?? []).map((b) => b.text).join(' '));
    // 说完了就收工
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  if (m.t === 'thinking') log(m.on ? '她在想…' : '她想完了');
  else if (m.t !== 'prefs') log('帧:', JSON.stringify(m).slice(0, 160));
});
ws.addEventListener('error', () => log('连不上(端口对吗?桌宠上桌了吗?)'));
setTimeout(() => {
  log(sent ? '超时:没等到她的气泡' : '超时:没连上');
  process.exit(1);
}, 90_000);
