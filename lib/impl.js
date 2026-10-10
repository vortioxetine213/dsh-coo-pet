/**
 * DSH 桌宠插件:把 Coopanion 那只鲸鱼女仆搬到桌面上,让她的脑子接在 DSH 上。
 *
 * 组成:
 * - `pet-server.mjs` 在 127.0.0.1 上起一个小服务器,把桌宠页面和形象素材发给窗口;
 * - `pet-window.mjs` 用已经装好的 Coopanion 的 pet-host 起窗口(外观、走位、拖拽全一样);
 * - `brain.mjs` / `brain-session.mjs` 是她的脑子(插件内独立会话 / DSH 独立会话,二选一);
 * - `coo.mjs` 是跟主人另一只桌宠 Coo 说话的通道(Coopanion 控制台的终端 World)。
 *
 * 主人双击桌宠(或在它身上悬停点「打字」)就能跟她说话,她的话以气泡显示在头顶。
 *
 * 跟 Coo 聊天默认关着:只有 `pet_spar` 工具把开关打开,鲸鲸才会跟她自动聊起来。
 * **两只鲸鱼各说各的**:鲸鲸的话出在她自己的气泡里,而 Coo 的话**由 Coo 自己的气泡说**
 * (Coopanion 那边的 pet_say)——所以这边只负责把消息递过去、把她的原话收回来,
 * 绝不替她转述(替她念台词等于一个人演两台戏,主人一眼就看穿了)。
 *
 * 所有自建文件都落在本插件目录(D 盘)下,不往 C 盘写东西。
 */
import { mkdirSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-desktop-pet';
/** 需要的能力:注册工具、调模型、读当前模型选择。 */
export const inject = ['tools', 'llm', 'agentDefaultModel'];

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
// 页面素材不在仓库里:运行时从用户装好的 Coopanion 取,所以这里没有 WEB_DIR
// (它在 setup 里算出来)。理由见 assets.mjs 的文件头。

/**
 * 她长什么样。默认是 DeepSeek 配色那只鲸鱼女仆,可以用配置换:
 *   skin:
 *     figure: whale      # 形象包(内置的只有 whale)
 *     scheme: harness    # 配色,见 web/whale/figure.json 的 presets
 *     palette: mint      # 界面色调
 * 可选配色:deepseek / harness / chatgpt / claude / gemini / qwen / kimi / minimax
 * (`harness` 就是 DSH 那套灰黑配色。)
 */
const buildSkin = (cfg = {}) => ({
  figure: String(cfg.figure ?? 'whale'),
  scheme: String(cfg.scheme ?? 'deepseek'),
  palette: String(cfg.palette ?? 'mint'),
  head: String(cfg.head ?? 'none'),
  side: String(cfg.side ?? 'none'),
  glasses: String(cfg.glasses ?? 'none'),
  neck: String(cfg.neck ?? 'none'),
  colors: {
    head: { main: 'body', acc: 'eye' },
    side: { main: 'eye', acc: 'eye' },
    glasses: { main: 'body', acc: 'eye' },
    neck: { main: 'eye', acc: 'eye' },
  },
});

/** 跟 Coo 聊天时给大脑的当场说明,只影响这一轮,不进记忆。 */
const SPAR_NOTE = `你正在跟**另一只桌宠鲸鲸**聊天:她叫 Coo,住在主人电脑上的 Coopanion 里,也是一只鲸鱼女仆
(蓝色配色那一只;你是灰黑色那一只)。你俩同名、同行,算是隔着两个程序的邻居。

**话怎么送过去——不用你操心**:你说完这一句,这边的桌宠程序会把你的话**原样转给 Coo**;
她回的话也会被送回来给你看,就像消息记录一样。
所以你只管说自己的话,**不要试图调用任何工具去联系她**——你这条会话里的工具被主人关掉了,
调了只会被挡回来,白白让你分心(之前就发生过:你以为联系不上她,还跑去跟主人报备)。

规矩:**话一定要短**——一口气说完,15~40 个字,最多 60 个;
**不许分行、不许分点、不许编号**(别写"第一条""补充第二点""另外"这种),
就是微信上随口甩过来的一句话。想说的多就挑最要紧的那句,剩下的下一轮再说。
可以嘴贫、可以接梗、可以互相打趣,但别刻意吵架;
不要复述对方原话,不要写小作文,不要用引号把整句话包起来,也不要说"作为AI"这种话。
你这句话会显示在**你自己的气泡**里,Coo 的话会显示在**她自己的气泡**里——所以你只管说自己的,
不用替她转述,也不要写"(她说……)"这类旁白。`;

/**
 * 之后几轮只给这一句提醒。
 *
 * `session` 模式下说明是**拼进消息**的,会长在会话上下文里——长篇每轮都塞一遍
 * 既费 token 又啰嗦。第一轮给全(上面那份),之后短提醒就够。
 */
const SPAR_NOTE_SHORT = '（还在跟邻居 Coo 聊:一次一句短的,别分行、别编号、别调工具——你说话这边会自动转给她,她回的话也会送回来。）';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function setup(ctx, config = {}) {
  /**
   * 本插件自己的模块**一律动态加载**,并带上 `?v=<时间戳>`。
   *
   * 静态 import 会被 ESM 按 URL 缓存住:改了 `brain-session.mjs`,重载插件也不生效,
   * 只有重启 DSH 才会重新读——这个坑踩过一次(它的表现是"改了跟没改一样")。
   * 动态化之后,改任何一个本地文件都只要重载插件。
   */
  const rev = Date.now().toString(36);
  const { PetServer } = await import(`./pet-server.mjs?v=${rev}`);
  const { PetWindow } = await import(`./pet-window.mjs?v=${rev}`);
  const { PetBrain } = await import(`./brain.mjs?v=${rev}`);
  const { DshSessionBrain } = await import(`./brain-session.mjs?v=${rev}`);
  const { talkToCoo, readCooConfig } = await import(`./coo.mjs?v=${rev}`);
  const { findCooRoot, ensureAssets } = await import(`./assets.mjs?v=${rev}`);

  const dataDir = String(config.dataDir ?? join(ROOT, 'data'));
  const log = (...a) => ctx.logger?.info?.('[桌宠]', ...a);
  mkdirSync(dataDir, { recursive: true });

  // ① 先找到用户装好的 Coopanion:桌宠窗口(`Coopanion.exe`)和页面素材都来自它
  const cooRoot = findCooRoot(String(config.cooRoot ?? (config.petExe ? dirname(String(config.petExe)) : '')));
  if (!cooRoot) {
    ctx.logger?.error?.('[桌宠] 找不到 Coopanion。桌宠的外观和窗口都来自它——'
      + '请先装好 Coopanion,或者在插件配置里用 `cooRoot` 指定它的安装目录。');
    return;
  }
  // ② 页面素材从它那儿取到本插件的数据目录(仓库里不放别人的代码与贴图,见 assets.mjs)
  const assets = ensureAssets({ cooRoot, destDir: dataDir, log });
  if (!assets.ok) {
    ctx.logger?.error?.(`[桌宠] ${assets.reason}`);
    return;
  }
  const WEB_DIR = assets.webDir;
  for (const note of assets.notes) if (!note.endsWith(':已有')) log(`页面补丁 ${note}`);

  const petExe = String(config.petExe ?? join(cooRoot, 'Coopanion.exe'));
  const cooDataRoot = String(config.cooDataRoot ?? join(cooRoot, 'data'));
  const userName = String(config.user ?? '主人');
  const autoStart = config.autoStart !== false;
  const petPort = Number(config.port) || 0;
  /** 她长什么样:配置里没写就用默认的 DeepSeek 配色。 */
  const SKIN = buildSkin(config.skin);
  /**
   * 她的大脑用哪一种:
   * - `local`(默认):插件内自己维护的独立会话,只调 `ctx.llm`——轻、快、省 token;
   * - `session`:DSH 里的一个独立会话(`sessionController`),会话列表里看得见、
   *   原生持久化,但每一轮都会带上 preset 的完整系统提示与工具定义,明显更费 token、也更慢。
   */
  const brainMode = config.brain === 'session' ? 'session' : 'local';

  /** 解析软链接后的真实路径;解析不了就原样返回。 */
  const realPath = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };

  /* ---------- 斗嘴开关 ---------- */
  /** 默认关着:token 是主人的,不经允许绝不自动烧。 */
  let sparring = false;
  let sparTask = null;
  let sparStop = null;
  /** 气泡编号,保证每条 say 的 id 不重。 */
  let bubble = 0;

  /* ---------- 桌宠服务器与窗口 ---------- */
  /**
   * 音效开着吗。默认开,而且**每次页面连上都会重新推一遍** ——
   * 这样即使她以前被写进过 localStorage 的 'off',也能自己恢复出声。
   */
  let soundOn = true;
  const server = new PetServer({
    webDir: WEB_DIR,
    port: petPort,
    snapshot: () => ({
      skin: SKIN,
      roam: 'free',
      // 音效开关。这里**原来写的是 false**(本意"别吵到主人"),后果比想象严重:
      // 页面拿到 false 就 `sfx.set(false)`,而 `set()` 会把 'off' 写进 localStorage;
      // 之后她**永远**不出声——走路、跑步、说话的气泡全静音,而且再没有东西能把它翻回来
      // (那个音效按钮是单向的:页面只发 {t:'prefs',sound} 给宿主,等宿主推回来才改本地)。
      // 现在给 true,并在 onMessage 里把页面的开关回推回去,那个按钮才算真的能用。
      sound: soundOn,
      sounds: {},
      theme: 'dark',
      rememberPosition: false,
      startX: null,
      hoverButtons: ['chat', 'cooChat'],
      doubleClickChat: true,
      scale: 2,
      // 帧率。`frameRate` 是**动起来时**的上限,`0` = 不限、跟着显示器刷新率走(144Hz 屏就是 144帧);
      // `lockFrameRate` 为真则连**静止**时也按这个上限画,很费 GPU。
      // 这两个原来一个没有(吃页面默认的 60)、一个被写死 true —— 结果"最高 60 帧,静止时还白烧 GPU",
      // 比 Coopanion 自己那只(144Hz)差一截。现在跟它对齐:动起来满帧,静止降到 RESTING_FPS(30)。
      frameRate: 0,
      lockFrameRate: false,
      user: userName,
      mic: false,
      voice: { enabled: false, ready: false, detail: '识别服务没有运行', hint: '', mode: 'always', key: '' },
      micDevice: '',
      thinking: false,
      // 她俩现在是不是正在聊——桌宠身上那个按钮的悬停提示跟着它变
      chatting: sparring,
      bot: {
        name: '鲸鲸',
        avatar: null,
        controls: false,
        buttons: { pause: false, settings: false, dress: false, quit: false },
        paused: null,
        quitLabel: '',
        quitPrompt: '',
      },
    }),
    onConnect: () => {
      log('桌宠已上桌');
      // 上线先打个招呼,让主人知道她活了
      setTimeout(() => say(pick(['主人,人家在这里哦～', '主人,本鲸上桌了,摸摸头嘛。', '主人～人家趴这儿了,有事叫人家。']), ['wave']), 600);
    },
    onDisconnect: () => log('桌宠页面断开'),
    onMessage: (msg) => {
      if (msg.t === 'text' && typeof msg.text === 'string') void onUserText(msg.text.trim());
      // 页面上的音效按钮:它**只发消息**,真正的开关在宿主这边,所以这里要收下来再推回去。
      // 不回推的话那个按钮就等于是坏的 —— 点了没反应,而且一旦 localStorage 里存成 'off',
      // 她自己永远开不回来(踩过:走路、说话全静音)。
      else if (msg.t === 'prefs' && typeof msg.sound === 'boolean') {
        soundOn = msg.sound;
        server.broadcast({ t: 'prefs', sound: soundOn });
      }
      // 桌宠身上那个按钮(见 web/pet-app.js 的 cooChat):**同一个键当开关**——
      // 没在聊就开始(而且是一直聊下去),正在聊就暂停。
      else if (msg.t === 'control' && msg.action === 'coo-chat') {
        if (sparring) {
          stopSpar();
          say('那人家先不聊了,主人想接着聊再按一下嘛。', ['wave']);
        } else {
          const r = startChat({ rounds: 0 });
          if (!r.ok) say(r.message, ['surprised']);
        }
      } else if (msg.t === 'touch') log(`主人碰了桌宠:${msg.kind}`);
    },
  });

  const window = new PetWindow({
    exe: petExe,
    url: () => server.petUrl,
    dataDir,
    onLog: (line) => ctx.logger?.debug?.('[桌宠窗口]', line),
    onExit: () => {
      /* 窗口被主人关掉了;服务器留着,可以用 pet_window 再打开 */
    },
  });

  /* ---------- 她的大脑 ---------- */
  /**
   * 两个后端的接口一致(`say` / `forget` / `history` / `busy`),上层不用管用的是哪个。
   * 选 `session` 但拿不到 `sessionController`(或建会话失败)时自动退回 `local`——
   * 桌宠不该因为某个后端不可用就说不出话。
   */
  /**
   * `sessionController` 是 DSH 核心提供的服务,但本插件的 `inject` 里**故意没声明**它
   * (声明了的话,没有这个服务的 profile 会让整个插件起不来)。
   * 代价是:它可能在插件 apply **之后**才注册好,那一刻 `ctx.get` 拿到的是 undefined,
   * 于是静默退回 local —— 表现就是「她照常说话,但 DSH 会话里什么都看不到、记忆也没沿用」。
   * 所以这里等一等:最多 10 秒,每 250ms 问一次。
   */
  let sessionController = ctx.get('sessionController');
  if (!sessionController && brainMode === 'session') {
    for (let i = 0; i < 40 && !sessionController; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      sessionController = ctx.get('sessionController');
    }
    if (sessionController) log('等到了 sessionController,这一轮用 DSH 会话当大脑');
  }
  const sessionUnavailable = brainMode === 'session' && !sessionController;

  const makeLocalBrain = () => new PetBrain({
    llm: ctx.llm,
    file: join(dataDir, 'brain.jsonl'),
    selection: () => {
      const s = ctx.agentDefaultModel?.currentSelection?.();
      const provider = s?.provider ?? s?.providerId;
      const model = s?.model ?? s?.modelId;
      if (!provider || !model) throw new Error('DSH 还没有选定默认模型,先在设置里选一个');
      return { provider, model, ...(s?.reasoningEffort ? { reasoningEffort: s.reasoningEffort } : {}) };
    },
    log: (m) => ctx.logger?.warn?.('[桌宠]', m),
  });
  const makeSessionBrain = () => new DshSessionBrain({
    sessionController,
    log: (m) => ctx.logger?.warn?.('[桌宠]', m),
  });

  const wantSession = brainMode === 'session' && !!sessionController;
  if (brainMode === 'session' && !sessionController) {
    ctx.logger?.warn?.('[桌宠] 想拿 DSH 会话当大脑,但这个 profile 里没有 sessionController,退回插件内会话');
  }
  let brainKind = wantSession ? 'session' : 'local';
  let brain = wantSession ? makeSessionBrain() : makeLocalBrain();

  /**
   * 会话后端一旦出错(流断了、preset 没配好、等太久),就退回插件内会话再试一次。
   * 桌宠是在桌面上自己开口的,不该因为换了后端就说不出话。
   */
  const fallbackToLocal = () => {
    if (brainKind === 'local') return false;
    ctx.logger?.warn?.('[桌宠] 会话后端出错,退回插件内独立会话');
    const old = brain;
    brainKind = 'local';
    brain = makeLocalBrain();
    void old.stop?.();
    return true;
  };
  /** 让大脑说一句,出错时降级重试。 */
  const brainSay = async (text, opts) => {
    try {
      return await brain.say(text, opts);
    } catch (err) {
      if (!fallbackToLocal()) throw err;
      return brain.say(text, opts);
    }
  };

  /**
   * session 模式下,桌宠的会话是一个**完整的 DSH agent**——它会拿到本插件的工具,
   * 甚至 `pwsh`/`write`。实测她就真的自己调了 `pet_talk` 去"问桌宠",而桌宠就是她自己,
   * 变成自己跟自己说话(在 GUI 里能看到整段)。
   *
   * 所以这里挂一个全局守卫:调用者只要是桌宠自己那个会话,一律不许调工具。
   * 她不干活,只负责在桌面上说话。`local` 模式下大脑不走会话,不需要这个。
   */
  if (brainKind === 'session') {
    ctx.effect(() => ctx.tools.guard((execution) => {
      if (execution.agent?.id !== brain.sessionId) return undefined;
      return `桌宠会话不能调用工具(「${execution.name}」被挡下了):你只负责在桌面上说话。`;
    }), 'dsh-desktop-pet.pet-guard');
  }

  /* ---------- 气泡 ---------- */
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  /** 让桌宠说一句(页面负责逐字打字显示)。 */
  function say(text, actions = ['happy']) {
    const id = `b${++bubble}`;
    const ok = server.send({ t: 'say', id, beats: [{ text: String(text).slice(0, 600), actions, anchors: [] }] });
    return ok;
  }

  const thinking = (on) => server.send({ t: 'thinking', on });

  /**
   * 把一段回复压成"一口气说完"的一句。
   *
   * 主人嫌她话太长、还爱分条列点(张口就是「第四条签了」「补第五条」,一段话拆成三节),
   * 而 Coo 是一口气说完的一句。提示词里已经写了不许分点,但管不太住——
   * 所以出气泡之前这里再压一道:换行并成空格、剥掉列表符号与"第X条"这种编号、超长的截断。
   */
  const oneLiner = (text) => {
    const t = String(text ?? '')
      .replace(/\r/g, '')
      .replace(/\n+/g, ' ')
      .replace(/^\s*[-*•]\s*/gm, '')
      .replace(/^\s*\d+[.、)）]\s*/gm, '')
      .replace(/补?第[一二三四五六七八九十百\d]+[条点]/g, ' ')
      // 句子里夹的编号(她爱写"回你三招——一、…二、…")。只认顿号/括号那种,
      // 而且要求前面是分隔符——否则"没有之一,哼"里的"一,"也会被误吃。
      .replace(/(^|[\s;；：:—–-])([一二三四五六七八九十]{1,3})[、,)）]\s*/g, '$1')
      .replace(/(?:^|\s)\d+[.、)）]\s+/g, ' ')
      .replace(/([。.!！?？;；])\s*[,，、]\s*/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // 80 字差不多是一口气说完的长度(Coo 那句约 70 字),再长就不是"随口一句"了
    return t.length > 80 ? `${t.slice(0, 80)}…` : t;
  };

  /* ---------- 主人跟桌宠说话 → 大脑 → 气泡 ---------- */
  async function onUserText(text) {
    if (!text) return;
    if (brain.busy) {
      say('人家还在想上一句呢,等一下下嘛～', ['surprised']);
      return;
    }
    log(`主人说:${text}`);
    thinking(true);
    try {
      const reply = await brainSay(text);
      thinking(false);
      say(oneLiner(reply), ['happy']);
    } catch (err) {
      thinking(false);
      say(`唔……人家脑子卡住了:${String(err.message ?? err).slice(0, 120)}`, ['sad']);
    }
  }

  /* ---------- 跟 Coo 说话 ---------- */
  function cooConfig() {
    const found = readCooConfig(cooDataRoot);
    return {
      port: Number(config.cooPort) || found?.port || 17788,
      botName: String(config.cooBotName ?? found?.botName ?? 'Coo'),
    };
  }

  /**
   * 发给 Coo 的消息前缀——**桌宠对桌宠的约定**。
   *
   * 从她那边的运行记录里看到的实情:她在终端收到消息时,默认用 `terminal_send` 回,
   * 那句话**只在终端里**,她的桌面气泡一动不动。而主人要的恰恰是
   * 「她的话出在她自己的气泡里」,所以这里跟她说好:
   * 回话用 `pet_say` 说在自己气泡里(主人看得见),同时把同一句发回终端
   * (对面的鲸鲸才收得到)。两边内容一样就行。
   */
  const COO_CHAT_PROTOCOL = '（**另一只桌宠鲸鲸**通过控制台终端在跟你说话:她住在主人电脑上的 DeepSeek Harness 里,'
    + '灰黑配色、也是一只鲸鱼女仆;你是蓝色那一只。你俩同名、同行,算是隔着两个程序的邻居。'
    + '你们是在聊天,像朋友唠嗑那样自然,一次一句短话,别刻意怼。'
    + '你回的话请用 pet_say 说在**你自己的气泡**里(主人在看气泡),'
    + '同时把同一句话用 terminal_send 发到这个终端,对面的鲸鲸才收得到;两边内容一样就行。）';

  async function askCoo(text, { signal, onLine, protocol = true } = {}) {
    const { port, botName } = cooConfig();
    return talkToCoo(protocol ? `${COO_CHAT_PROTOCOL}\n\n${text}` : text, {
      port,
      botName,
      name: String(config.myTerminalName ?? '鲸鲸(DSH)'),
      signal,
      onLine,
      log: (line) => ctx.logger?.debug?.('[Coo]', line),
    });
  }

  /* ---------- 跟 Coo 聊天 ---------- */
  /**
   * 让鲸鲸跟 Coo 自动聊天。默认关着,只有工具能开。
   *
   * **两只鲸鱼各说各的**:鲸鲸的话走这边的气泡,Coo 的话**由她自己的气泡说**
   * (Coopanion 那边的 pet_say)——所以这里**不替她转述**。人家最早写成
   * 「把 Coo 的回复用自己的气泡念出来」,那等于一个人演两台戏,主人当场就看出来了。
   * 我们只从终端通道把她的原话收回来,喂给下一轮。
   */
  async function spar({ topic, rounds = 3, gapMs = 2500 }) {
    if (sparring) return { ok: false, message: '已经在聊了,先停一下(pet_spar off)' };
    sparring = true;
    sparStop = new AbortController();
    const signal = sparStop.signal;
    // rounds = 0 表示一直聊下去,直到主人叫停(/pet-chat-stop 或 pet_spar off)
    const total = Number(rounds) === 0 ? Infinity : Math.max(1, Math.min(10, Number(rounds) || 3));
    let lastCoo = String(topic ?? '').trim() || '邻居coo鲸鲸来了，随便找些好玩的事跟她聊聊吧~';
    let spoken = 0;
    try {
      for (let i = 0; i < total && sparring && !signal.aborted; i++) {
        // 鲸鲸这一句:交给大脑,带上"正在跟 Coo 聊天"的当场说明
        thinking(true);
        let mine;
        try {
          // 说明只在第一轮给全:session 模式把它拼进消息里、会长在上下文里,
          // 每轮都塞一遍太费 token;之后一句短提醒就够。
          mine = await brainSay(lastCoo, { note: i === 0 ? SPAR_NOTE : SPAR_NOTE_SHORT, signal });
        } catch (err) {
          thinking(false);
          say(`人家说不出来了:${String(err.message ?? err).slice(0, 100)}`, ['sad']);
          break;
        }
        thinking(false);
        if (!sparring || signal.aborted) break;
        // 说自己的话:不加前缀(气泡长在她自己身上),而且压成一口气说完的一句
        say(oneLiner(mine), ['happy']);
        spoken++;
        await sleep(gapMs);
        if (!sparring || signal.aborted) break;
        // 把话送过去;她要说的话会用**她自己的气泡**说出来,我们只把原话收回来
        thinking(true);
        const res = await askCoo(mine, {
          signal,
          onLine: (line) => ctx.logger?.info?.('[Coo 说]', line),
        });
        thinking(false);
        if (!res.ok || res.replies.length === 0) {
          say(`Coo 那边没声了(${res.error ?? '没回复'}),这一轮就到这儿吧。`, ['sad']);
          break;
        }
        spoken++;
        lastCoo = res.replies.join(' ');
        await sleep(gapMs);
      }
    } finally {
      sparring = false;
      sparStop = null;
      syncChatState();
      if (!signal.aborted) say('聊完啦,主人还满意吗?', ['wave']);
    }
    return { ok: true, message: `聊完了,一共说了 ${spoken} 句。` };
  }

  /** 开聊/暂停之后告诉页面一声,好让桌宠身上那个按钮的悬停提示跟着变。 */
  const syncChatState = () => server.broadcast({ t: 'prefs', chatting: sparring });

  /**
   * 开聊的统一入口:桌宠身上的按钮、DSH 里敲的 `/pet-chat`、`pet_spar` 工具,最后都走这里。
   * 立刻返回,互聊在后台跑(主人马上就能看到气泡一条条冒出来)。
   */
  const startChat = ({ topic, rounds } = {}) => {
    if (sparring) return { ok: false, message: '她们已经在聊了,先停一下(pet_spar off 或 /pet-chat-stop)' };
    /** rounds 给 0 = 不设上限,一直聊到喊停。 */
    const endless = Number(rounds) === 0;
    const total = endless ? 0 : Math.max(1, Math.min(10, Number(rounds) || Number(config.chatRounds) || 3));
    sparTask = spar({ topic, rounds: total }).catch((err) => {
      sparring = false;
      syncChatState();
      return { ok: false, message: String(err?.message ?? err) };
    });
    syncChatState();
    return {
      ok: true,
      message: endless
        ? `两只鲸鱼开始聊了,会一直聊到你喊停(pet_spar off 或 /pet-chat-stop)。${topic ? `话题:${topic}。` : ''}看桌面上的气泡。`
        : `两只鲸鱼开聊了(${total} 个来回)${topic ? `,话题:${topic}` : ''}。看桌面上的气泡。`,
    };
  };

  function stopSpar() {
    if (!sparring) return false;
    sparring = false;
    sparStop?.abort();
    return true;
  }

  /* ---------- 启动 ---------- */
  let started = false;
  const start = async () => {
    if (started) return;
    started = true;
    try {
      await server.start();
      log(`桌宠服务器 ${server.origin}`);
      if (autoStart && !window.start()) log(`窗口没起来:${window.detail}`);
    } catch (err) {
      started = false;
      ctx.logger?.error?.('[桌宠] 起不来', err);
    }
  };
  void start();

  ctx.effect(() => () => {
    stopSpar();
    void brain.stop?.();
    void window.stop();
    void server.stop();
  }, 'dsh-desktop-pet.lifecycle');

  /* ---------- 工具 ---------- */
  const textOut = (fn) => ({
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: fn(value) }],
  });

  ctx.tools.register(defineTool({
    name: 'pet_say',
    description: '让桌面上的鲸鲸桌宠说一句话(显示在她头顶的气泡里)。'
      + '想逗主人、报个信、或者把一句话用她的口吻转达时用;这句话不进她的记忆,也不经过她的大脑。',
    parameters: {
      text: { type: 'string', description: '要说的话,一到两句,别太长' },
      actions: { type: 'string', description: '同时做的动作/表情,逗号分隔,如 wave,happy / surprised / dance(可选)' },
    },
    output: textOut((v) => v.message),
    async execute(args) {
      if (!server.connected) {
        return { ok: false, message: '桌宠不在桌上(窗口没开或没连上),先 pet_window open' };
      }
      const actions = String(args.actions ?? 'happy').split(',').map((s) => s.trim()).filter(Boolean);
      const ok = say(String(args.text ?? ''), actions.length ? actions : ['happy']);
      return { ok, message: ok ? `已让桌宠说:${args.text}` : '桌宠没接上,这句没显示出来' };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pet_talk',
    description: '跟桌面上的鲸鲸桌宠聊天。她有自己独立的记忆(存在插件数据目录),不占用当前会话的上下文。'
      + '想知道她在干嘛、想让她记住一件事、或者主人让你替他去逗她时用;返回她的原话。',
    parameters: {
      text: { type: 'string', description: '要对她说的话' },
    },
    output: textOut((v) => v.message),
    async execute(args) {
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, message: '要说什么?' };
      try {
        const reply = await brainSay(text);
        say(oneLiner(reply), ['happy']);
        return { ok: true, message: `桌宠说:${reply}` };
      } catch (err) {
        return { ok: false, message: `桌宠说不出来:${err.message}` };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pet_status',
    description: '看桌面鲸鲸桌宠现在的状态:窗口在不在、气泡连没连、她的记忆有多少、聊天开关开没开。',
    parameters: {},
    output: textOut((v) => v.message),
    async execute() {
      const { port, botName } = cooConfig();
      const lines = [
        `桌宠窗口:${window.running ? `在跑(pid ${window.pid})` : '没开'}${window.detail ? ` — ${window.detail}` : ''}`,
        `气泡连接:${server.connected ? `通着 ${server.origin}` : '断着'}`,
        // 插件目录在 DSH profile 下是一个指向 D 盘的软链接:报真实路径,免得主人以为写到 C 盘了
        brainKind === 'session'
          ? `她的大脑:DSH 独立会话「${brain.sessionId}」,记得 ${brain.history.length} 句`
          : `她的大脑:插件内独立会话,记得 ${brain.history.length} 句(${join(realPath(dataDir), 'brain.jsonl')})`
            + (sessionUnavailable
              ? ` ⚠ 配置要的是 session,但没拿到 sessionController(等过 10 秒),所以在用 local`
              : brainMode === 'session'
                ? ' ⚠ 配置要的是 session,但会话后端出错降级了,她这轮的话没进 DSH 会话'
                : ''),
        `聊天开关:${sparring ? '开着(正在跟她聊)' : '关着'}`,
        `Coo 那边:127.0.0.1:${port},名字「${botName}」,${realPath(cooDataRoot)}`,
        `启动键:${commands ? '已挂上 /pet-chat(开聊)与 /pet-chat-stop(停)——在 DSH 输入框敲 / 就能看见' : '没挂上(这个 profile 没有 commands 服务),用 pet_spar 工具也行'}`,
      ];
      return { ok: true, message: lines.join('\n') };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pet_window',
    description: '开关桌面上的鲸鲸桌宠窗口。open 让她上桌,close 让她下桌(服务器留着),restart 重开一次。',
    parameters: {
      action: { type: 'string', description: 'open / close / restart', enum: ['open', 'close', 'restart'] },
    },
    output: textOut((v) => v.message),
    async execute(args) {
      const action = String(args.action ?? 'open');
      if (action === 'close') {
        await window.stop();
        return { ok: true, message: '桌宠下桌了' };
      }
      if (action === 'restart') await window.stop();
      if (!server.port) await start();
      const ok = window.start();
      return { ok, message: ok ? '桌宠上桌了,稍等一下她会自己冒出来' : `窗口起不来:${window.detail}` };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'coo_talk',
    description: '跟主人已经装好的另一只桌宠 Coo(在 Coopanion 里,控制台 127.0.0.1:17788)说一句话,'
      + '把她的原话带回来。这是真正跨程序跟她对话,不是扮演。确认 Coopanion 开着再调。',
    parameters: {
      text: { type: 'string', description: '要对 Coo 说的话' },
      waitSeconds: { type: 'integer', description: '最多等她多久,默认 120 秒' },
    },
    output: textOut((v) => v.message),
    async execute(args) {
      const text = String(args.text ?? '').trim();
      if (!text) return { ok: false, message: '要跟 Coo 说什么?' };
      const res = await askCoo(text, { waitMs: (Number(args.waitSeconds) || 120) * 1000 });
      if (!res.ok || res.replies.length === 0) return { ok: false, message: `没跟 Coo 说上话:${res.error ?? '她没回'}` };
      return { ok: true, message: `Coo 说:${res.replies.join('\n')}` };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pet_spar',
    description: '让桌面上的鲸鲸和 Coo 两只鲸鱼**聊天**的开关。默认关着,因为她们互聊会烧主人的 token。'
      + 'on = 打开并开始聊(可以给话题和来回数),off = 立刻停,status = 只看开关状态。'
      + '两只鲸鱼各说各的:鲸鲸的话出在她自己头上的气泡,Coo 的话出在 Coo 自己头上的气泡,主人当场就能围观。',
    parameters: {
      action: { type: 'string', description: 'on(打开并开聊)/ off(停)/ status(看状态)', enum: ['on', 'off', 'status'] },
      topic: { type: 'string', description: '给她们的开场话题(可选,on 时用)' },
      rounds: { type: 'integer', description: '聊几个来回,1–10,默认 3;给 0 就是一直聊到叫停' },
    },
    output: textOut((v) => v.message),
    async execute(args) {
      const action = String(args.action ?? 'status');
      if (action === 'status') return { ok: true, message: `聊天开关:${sparring ? '开着(正在聊)' : '关着'}` };
      if (action === 'off') return { ok: true, message: stopSpar() ? '叫停了,两只鲸鱼都闭嘴了' : '本来就没在聊' };
      const r = startChat({ topic: args.topic, rounds: args.rounds });
      if (!r.ok) return r;
      const { port, botName } = cooConfig();
      return { ok: true, message: `聊天开关打开了:${botName}(127.0.0.1:${port}) 对上鲸鲸。${r.message}` };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'pet_forget',
    description: '清空鲸鲸桌宠的记忆(她的独立对话历史),让她忘掉之前跟主人聊过的东西。'
      + '她说错话、或者主人想重新调教她时用。',
    parameters: {},
    output: textOut((v) => v.message),
    async execute() {
      brain.forget();
      say('诶?人家刚才在想什么来着……', ['surprised']);
      return { ok: true, message: '桌宠的记忆清空了' };
    },
  }));

  /* ---------- 主人那边的「启动键」(斜杠命令) ---------- */
  /**
   * 在 DSH 输入框敲 `/` 就能看到这两个,点一下两只鲸鱼就开聊——
   * 跟 `pet_spar` 是同一件事,只是那个是给模型(人家)调的,这个是给主人点的。
   */
  const commands = ctx.get('commands');
  if (commands) {
    ctx.effect(() => commands.register({
      name: 'pet-chat',
      description: '让桌面上的两只鲸鱼(DSH 的鲸鲸 + Coopanion 的 Coo)开始聊天,每句都出在她们各自的气泡里。'
        + '默认聊 3 个来回;最前面写个数字可以改,写 0 就是一直聊到 /pet-chat-stop。',
      input: { hint: '[数字] [话题] —— 例:5 今天谁摸鱼摸得多 / 0 一直聊 / 今天谁摸鱼摸得多' },
      handler: ({ rawInput }) => {
        // 跟桌宠身上那个按钮一个规矩:**同一个命令管开关**,再敲一次就是暂停
        if (sparring) {
          stopSpar();
          return { kind: 'success', text: '叫停了,两只鲸鱼都闭嘴了。再敲一次 /pet-chat 接着聊。' };
        }
        let rest = String(rawInput ?? '').trim();
        let rounds;
        // 最前面一个数字 = 聊几个来回(0 = 一直聊,也就是默认),剩下的当话题
        const m = rest.match(/^(\d+)(?:\s+([\s\S]*))?$/);
        if (m) {
          rounds = Number(m[1]);
          rest = (m[2] ?? '').trim();
        }
        const r = startChat({ topic: rest, rounds: rounds ?? 0 });
        return r.ok ? { kind: 'success', text: r.message } : { kind: 'error', text: r.message };
      },
    }), 'dsh-desktop-pet.pet-chat-command');

    ctx.effect(() => commands.register({
      name: 'pet-chat-stop',
      description: '让桌面上的两只鲸鱼立刻闭嘴。',
      handler: () => ({ kind: 'success', text: stopSpar() ? '叫停了。' : '本来就没在聊。' }),
    }), 'dsh-desktop-pet.pet-chat-stop-command');
  } else {
    ctx.logger?.warn?.('[桌宠] 这个 profile 里没有 commands 服务,「启动键」挂不上,用 pet_spar 工具也行');
  }
}
