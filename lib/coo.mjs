/**
 * 跟主人已经装好的那只桌宠 Coo 说话。
 *
 * 走的是 Coopanion(Cortico)控制台内建「终端对话」World 的流式通道:
 *   ws://127.0.0.1:<console-port>/ws/providers/world%3Aterminal/panels/chat
 * 协议是 JSON 行:`{type:'hello',name}` 报名,`{type:'msg',text}` 发言,
 * 服务端广播 `{type:'msg',from,text,ts}`,自己发的话也会被广播回来,按名字滤掉。
 *
 * 每次说话开一条新连接:Coopanion 那条通道的设计就是"一条连接 = 一个在场的人",
 * 断了就是离开了对话,不留脏状态;重连时它会把最近的历史回放一遍(带 history:true),
 * 那些不当成新回复。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Coopanion 默认的控制台端口(它自己 seed 的 CONSOLE_PORT)。 */
export const DEFAULT_COO_PORT = 17788;
/** 等 Coo 开口的上限:她要跑一遍模型。 */
const DEFAULT_WAIT_MS = 120_000;
/** 她说完之后安静这么久,就当这一轮说完了。 */
const DEFAULT_QUIET_MS = 12_000;

/**
 * 从 Coopanion 的数据目录读它真实的控制台端口与 bot 名字。
 * @param {string} dataRoot Coopanion 的 data 目录
 */
export function readCooConfig(dataRoot) {
  try {
    const file = join(dataRoot, 'home', 'companion', 'config.json');
    if (!existsSync(file)) return null;
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    return {
      port: Number(cfg?.web?.port) || DEFAULT_COO_PORT,
      botName: String(cfg?.displayName ?? '') || 'Coo',
      language: String(cfg?.language ?? 'zh'),
    };
  } catch {
    return null;
  }
}

/**
 * 跟 Coo 说一句话,把她的回复收齐。
 *
 * @param {object} opts
 * @param {number} [opts.port] Coopanion 控制台端口
 * @param {string} [opts.name] 我在终端里报的名字
 * @param {string} [opts.botName] 她的名字;用来把她的话和别人的话分开
 * @param {number} [opts.waitMs]
 * @param {number} [opts.quietMs]
 * @param {AbortSignal} [opts.signal]
 * @param {(line: string) => void} [opts.onLine] 每收到一句就回调一次(斗嘴时用)
 * @param {(line: string) => void} [opts.log]
 * @returns {Promise<{ ok: boolean, replies: string[], error?: string }>}
 */
export function talkToCoo(text, opts = {}) {
  const port = opts.port ?? DEFAULT_COO_PORT;
  const name = opts.name ?? '鲸鲸(DSH)';
  const botName = opts.botName ?? 'Coo';
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const log = opts.log ?? (() => {});
  const url = `ws://127.0.0.1:${port}/ws/providers/${encodeURIComponent('world:terminal')}/panels/chat`;

  return new Promise((resolve) => {
    const replies = [];
    let ws = null;
    let sent = false;
    let settled = false;
    let quietTimer = null;
    let waitTimer = null;

    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(waitTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      try {
        ws?.close();
      } catch {
        /* 已经断了 */
      }
      resolve({ ok, replies, ...(error ? { error } : {}) });
    };
    function onAbort() {
      finish(false, '被取消了');
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const armQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish(true), quietMs);
    };

    try {
      ws = new WebSocket(url);
    } catch (err) {
      finish(false, `连不上 Coo:${err.message}`);
      return;
    }
    waitTimer = setTimeout(() => finish(replies.length > 0, replies.length ? undefined : '等 Coo 回话超时'), waitMs);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', name }));
    });

    ws.addEventListener('message', (ev) => {
      let frame = null;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame?.type === 'sys') {
        log(`[coo] ${frame.text}`);
        // 报完名字再发言
        if (!sent && /你好|Hello/.test(String(frame.text))) {
          sent = true;
          setTimeout(() => {
            try {
              ws.send(JSON.stringify({ type: 'msg', text }));
            } catch (err) {
              finish(false, `发不出去:${err.message}`);
            }
          }, 400);
        }
        return;
      }
      if (frame?.type !== 'msg') return;
      const from = String(frame.from ?? '');
      if (from === name) return; // 自己说的话被广播回来了
      if (frame.history) return; // 重连时的历史回放,不是新回复
      const body = String(frame.text ?? '').trim();
      if (!body) return;
      if (botName && from !== botName) {
        log(`[coo] 场上还有别人(${from}),这句不算 Coo 的`);
        return;
      }
      replies.push(body);
      opts.onLine?.(body);
      armQuiet();
    });

    ws.addEventListener('error', () => {
      finish(false, `连 Coo 的终端通道出错(确认 Coopanion 开着,控制台在 127.0.0.1:${port})`);
    });
    ws.addEventListener('close', (e) => {
      if (settled) return;
      finish(replies.length > 0, replies.length ? undefined : `连接被关上(code=${e.code})`);
    });
  });
}
