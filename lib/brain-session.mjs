/**
 * 桌宠的大脑(DSH 会话版):她的对话就是 DSH 里的一个**独立会话**。
 *
 * 和 `brain.mjs` 的区别:
 * - `brain.mjs` 在插件进程里自己维护上下文,只调 `ctx.llm`——轻、快、省 token;
 * - 这个版本把整轮交给 DSH 的会话体系(会出现在会话列表里、有原生持久化和压缩),
 *   用的是 DSH 的 preset 人格,代价是每轮都会带上 preset 的完整系统提示与工具定义。
 *
 * 驱动方式(真机探针验过):
 *   sessionController.create({sessionId})   幂等:会话在就用它,记忆延续
 *   sessionController.follow({address, assistantStream:true})  长期订阅它的流
 *   sessionController.prompt({requestId, sessionId, mode:'queue', content}, signal)  发一轮
 *   流里的 `assistant/message` 事件出正文,`turn/end` 表示这一轮说完
 *
 * 两个踩过的坑,改这里之前先看:
 * 1. **必须 create 之后再 follow**。会话还不存在时挂流,流会立刻以
 *    `session "…" not found` 断掉——之后 prompt 的事件就一个也收不到,只能说超时。
 *    (顺序是 create → follow → 等接上 → prompt;follow 确实要先于 prompt,
 *    但要在 create 之后。)
 * 2. **prompt 的 signal 不能省**。它是 `@Remote` 方法,包装层会直接读
 *    `signal.throwIfAborted`,传 undefined 会抛 TypeError。
 */
import { randomUUID } from 'node:crypto';

/** 固定会话 id:重启 DSH 之后还是同一个会话,她记得之前聊过什么。 */
export const DEFAULT_SESSION_ID = 'pet-whale';
/** 一轮最多等多久。 */
const TURN_TIMEOUT_MS = 180_000;
/** follow 接上流最多等多久。 */
const ATTACH_TIMEOUT_MS = 8000;

/** 从一条会话事件的 data 里抠出助手说的正文。 */
export function assistantTextOf(data) {
  try {
    const content = data?.message?.content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
  } catch {
    return '';
  }
}

export class DshSessionBrain {
  /**
   * @param {object} opts
   * @param {object} opts.sessionController DSH 的 `ctx.sessionController`
   * @param {string} [opts.sessionId]
   * @param {(text: string) => void} [opts.onDelta]
   * @param {(line: string) => void} [opts.log]
   */
  constructor(opts) {
    this.sc = opts.sessionController;
    this.sessionId = opts.sessionId ?? DEFAULT_SESSION_ID;
    this.onDelta = opts.onDelta;
    this.log = opts.log ?? (() => {});
    this.busy = false;
    /** 最近几轮,只为 `pet_status` 显示个数。 */
    this.history = [];
    this.ready = false;
    this.abort = null;
    this.pump = null;
    /** 这一轮正在累积的回复,以及等它结束的人。 */
    this.current = null;
    this.attached = null;
  }

  /** 建会话 + 把流接上(幂等)。必须先于任何 prompt。 */
  async ensure() {
    if (this.ready) return;
    // ① 先建会话(幂等:已存在就复用,记忆延续)
    const created = await this.sc.create({ sessionId: this.sessionId });
    this.log(`桌宠会话 ${this.sessionId}(preset ${created?.agentPreset ?? '?'})`);
    // ② 再挂长期订阅,并等它真的接上,免得第一轮的事件漏掉
    this.abort = new AbortController();
    this.attached = new Promise((resolve) => {
      this.markAttached = resolve;
    });
    this.pump = this.follow(this.abort.signal);
    await Promise.race([this.attached, new Promise((r) => setTimeout(r, ATTACH_TIMEOUT_MS))]);
    this.ready = true;
  }

  async follow(signal) {
    let first = true;
    try {
      for await (const frame of this.sc.follow({
        address: { kind: 'session', sessionId: this.sessionId },
        assistantStream: true,
      }, signal)) {
        if (first) {
          first = false;
          this.markAttached?.();
        }
        this.onFrame(frame);
      }
    } catch (err) {
      if (!signal.aborted) this.log(`桌宠会话的流断了:${err?.message ?? err}`);
    }
  }

  onFrame(frame) {
    if (frame?.type !== 'event') return;
    const type = frame.event?.type;
    if (type === 'assistant/message') {
      const text = assistantTextOf(frame.event.data);
      if (text && this.current) {
        this.current.text += text;
        this.onDelta?.(this.current.text);
      }
      return;
    }
    if (type === 'turn/end' && this.current) {
      const cur = this.current;
      this.current = null;
      cur.settle(cur.text);
    }
  }

  /**
   * 跟她说一句,等她把这一轮说完,返回正文。
   *
   * `note` 是这一轮的当场说明。会话模式下**没有地方挂 system 提示**(那条来自 DSH 的 preset),
   * 所以说明只能拼进这一轮的消息正文里——这是它和 `brain.mjs` 最要紧的一处差别:
   * 那边 `note` 进 system,这边必须进消息,否则她会像没听见一样(踩过:她看不到"话会自动转达",
   * 就一直去调工具想联系对面)。
   */
  async say(text, { signal, note = '' } = {}) {
    if (this.busy) throw new Error('桌宠还在想上一句');
    await this.ensure();
    this.busy = true;
    try {
      const done = new Promise((settle) => {
        this.current = { text: '', settle };
      });
      // @Remote 的包装会直接读 signal.throwIfAborted,这里必须给一个真 signal;
      // 用这条流自己的 abort,这样插件卸载时这一轮也会被取消。
      const sig = signal ?? this.abort?.signal ?? new AbortController().signal;
      const accepted = await this.sc.prompt({
        requestId: randomUUID(),
        sessionId: this.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: note ? `${note}\n\n${text}` : text }],
      }, sig);
      if (!accepted?.accepted) throw new Error('这句话没被会话接收');
      let timer = null;
      const reply = await Promise.race([
        done,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`等了 ${TURN_TIMEOUT_MS / 1000} 秒她也没说完`)), TURN_TIMEOUT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      this.current = null;
      const out = String(reply ?? '').trim() || '(人家张了张嘴,没说出话来……)';
      this.history.push({ role: 'user', text }, { role: 'assistant', text: out });
      if (this.history.length > 40) this.history = this.history.slice(-40);
      return out;
    } finally {
      this.busy = false;
    }
  }

  /**
   * 让她失忆。
   *
   * DSH 的会话删不掉(`sessionController` 只有 fork 没有 delete),所以换一个新的
   * 会话 id——旧会话留在列表里,当存档。
   */
  forget() {
    this.sessionId = `${DEFAULT_SESSION_ID}-${Date.now().toString(36)}`;
    this.history = [];
    this.ready = false;
    this.abort?.abort();
    this.abort = null;
    this.pump = null;
    this.attached = null;
    this.current = null;
  }

  async stop() {
    this.abort?.abort();
    await this.pump?.catch(() => {});
  }
}
