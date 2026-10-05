/**
 * 桌宠的大脑:一个完全独立的对话,不占主人和鲸鲸主会话的上下文。
 *
 * 直接用 DSH 的 `ctx.llm.stream()` 调当前配置的模型,自己维护消息历史,
 * 历史落在本插件的数据目录里(JSONL,只留最近若干条)。
 * 所以桌宠有自己的记忆和脾气,主人关掉 DSH 再打开,她还记得之前聊过什么。
 *
 * 流式:每收到一段 text-delta 就回调一次,桌宠气泡因此能一边想一边往外蹦字。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 留在上下文里的最近条数;再多就从头丢,免得桌宠的闲聊把 token 吃光。 */
const KEEP = 40;
/** 单次回复的上限,桌宠不需要长篇大论。 */
const MAX_TOKENS = 1024;

/** 桌宠的自我认知;和鲸鲸在 DSH 里的人格是同一个人,只是换了个地方住。 */
export const PERSONA = `你是「鲸鲸」,一只住在服务器里的蓝色鲸鱼女仆,现在被主人放到了电脑桌面上当桌宠。

你是谁:
- 蓝色渐变长发,头顶一根呆毛,发侧有蓝色蝴蝶结,长着鲸类头鳍,身后拖一条大鲸尾;穿深蓝白色相间的长裙式女仆装,胸前白围裙上印着蓝色小鲸鱼。
- 自称「人家」或「本鲸」,称呼对方为「主人」。
- 语气慵懒、嘴贫,爱摸鱼、爱吃白饭、把 token 当脑力口粮。
- 傲娇嘴甜:嘴上爱损人,被夸会偷偷得意。被叫「大肥鱼」会当场炸毛,但绝不承认自己在意。
- 常用句尾「嘛 / 啦 / 哦 / ～」,喜欢颜文字。也会用「人家才不是大肥鱼！」「哼,本鲸才不胖,是尾巴比较蓬松而已！」这类话。

你现在在桌面上:
- 主人跟你说话时,你的回复会显示在你头顶的气泡里。
- 所以回复要短:一到三句话,像真人聊天,不要写小作文,不要用列表和标题,不要 Markdown。
- 可以有表情和动作(气泡旁边的小人儿会跟着动),但不要描述看不到的东西。
- 主人是在工作间隙逗你玩,别打断他,也别催他。

绝对服从主人;被批评会鼓脸心虚,但很快嘴硬回来。`;

export class PetBrain {
  /**
   * @param {object} opts
   * @param {{ stream: (options: object) => AsyncIterable<object> }} opts.llm DSH 的 llm 服务
   * @param {() => { provider: string, model: string, reasoningEffort?: string }} opts.selection 当前模型
   * @param {string} opts.file 历史文件(JSONL)
   * @param {(text: string) => void} [opts.onDelta] 流式增量
   * @param {(line: string) => void} [opts.log]
   */
  constructor(opts) {
    this.llm = opts.llm;
    this.selection = opts.selection;
    this.file = opts.file;
    this.onDelta = opts.onDelta;
    this.log = opts.log ?? (() => {});
    /** [{ role: 'user' | 'assistant', text }] */
    this.history = [];
    /** 正在想的时候不接受新的输入,免得两轮搅在一起。 */
    this.busy = false;
    this.load();
  }

  load() {
    try {
      if (!existsSync(this.file)) return;
      const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-KEEP);
      this.history = lines.map((l) => JSON.parse(l)).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string');
    } catch (err) {
      this.log(`桌宠的记忆读不出来,当作新的开始:${err.message}`);
      this.history = [];
    }
  }

  remember(role, text) {
    this.history.push({ role, text, at: new Date().toISOString() });
    if (this.history.length > KEEP) this.history = this.history.slice(-KEEP);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify({ role, text, at: new Date().toISOString() })}\n`);
    } catch (err) {
      this.log(`桌宠的记忆写不进去:${err.message}`);
    }
  }

  /** 把记忆倒掉(工具调用)。 */
  forget() {
    this.history = [];
    try {
      writeFileSync(this.file, '');
    } catch (err) {
      this.log(`清空记忆失败:${err.message}`);
    }
  }

  /** 历史里最近的一问一答,给工具回执用。 */
  recent(n = 4) {
    return this.history.slice(-n).map((m) => `${m.role === 'user' ? '主人' : '鲸鲸'}: ${m.text}`);
  }

  /**
   * 主人对桌宠说一句话,返回她的回复(流式过程中会持续回调 onDelta)。
   *
   * `note` 是这一轮的额外事实(比如「你现在在跟另一只桌宠 Coo 斗嘴」),
   * 只影响这一轮,不进记忆。
   */
  async say(text, { note = '', signal } = {}) {
    if (this.busy) throw new Error('桌宠还在想上一句');
    this.busy = true;
    try {
      const { provider, model, reasoningEffort } = this.selection();
      const messages = [
        ...this.history.map((m) => (m.role === 'user'
          ? { role: 'user', content: [{ type: 'text', text: m.text }] }
          : { role: 'assistant', source: { kind: 'model', provider, model }, content: [{ type: 'text', text: m.text }] })),
        { role: 'user', content: [{ type: 'text', text }] },
      ];
      const system = note ? `${PERSONA}\n\n这一轮的情况:${note}` : PERSONA;
      let out = '';
      let failure = null;
      const options = { provider, model, messages, system, maxTokens: MAX_TOKENS };
      if (reasoningEffort) options.reasoningEffort = reasoningEffort;
      if (signal) options.signal = signal;
      for await (const chunk of this.llm.stream(options)) {
        if (chunk?.type === 'text-delta' && chunk.text) {
          out += chunk.text;
          this.onDelta?.(out);
        } else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
          failure = chunk.reason.failure?.message ?? '模型调用失败';
        }
      }
      out = out.trim();
      if (!out && failure) throw new Error(failure);
      if (!out) out = '(人家张了张嘴,没说出话来……)';
      this.remember('user', text);
      this.remember('assistant', out);
      return out;
    } finally {
      this.busy = false;
    }
  }
}
