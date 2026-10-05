/**
 * 桌宠页面素材的来源。
 *
 * 页面素材(`pet.html` / `pet-app.js` / `pet.css` / whale 贴图…)不是本项目的作品:
 * 它们出自 Coopanion 的 `cortico-world-desktop-pet` 包,那个包是 **AGPL-3.0**,
 * 而 `web/whale/` 那批贴图连 AGPL 都不覆盖——原作者在 THIRD_PARTY_NOTICES 里
 * 明确写了"不在本包的 AGPL 授权范围内",而且围裙上印着 DeepSeek、OpenAI、
 * Anthropic、Google、阿里云、月之暗面、MiniMax 的商标。
 *
 * 所以本仓库**一张图、一行别人的代码都不放**,改成运行时从用户已经装好的
 * Coopanion 里取:把它的 `cortico-world-desktop-pet/web/` 复制到本插件的数据目录,
 * 再对 `pet-app.js` 打三处补丁(加那个"跟邻居 Coo 聊天"的按钮)。
 *
 * 这对用户不算额外要求:桌宠窗口本来就要用 Coopanion 的 `Coopanion.exe`。
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 装着页面素材的那个包,相对于 Coopanion 的安装目录。 */
export const PET_PKG = join('resources', 'app', 'node_modules', 'cortico-world-desktop-pet');

/** 装得比较多的几个位置;注册表也问不到时,拿这些兜底。 */
const COMMON_ROOTS = [
  process.env.COOPANION_HOME ?? '',
  'C:\\Program Files\\Coopanion',
  'C:\\Program Files (x86)\\Coopanion',
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Coopanion'),
  join(process.env.APPDATA ?? '', 'Coopanion'),
];

let registryCache = null;

/**
 * 问 Windows 的"卸载信息",把 Coopanion 的安装目录捞出来。
 *
 * 用户完全可能装在 D 盘、E 盘或者某个自建目录里,光猜常见位置是不够的;
 * 而只要用安装包装过,注册表就会留下 InstallLocation。结果缓存一次,
 * 免得每次挂载都去 query 一遍注册表。
 */
function fromRegistry() {
  if (registryCache) return registryCache;
  registryCache = [];
  if (process.platform !== 'win32') return registryCache;
  for (const hive of ['HKCU', 'HKLM']) {
    const key = `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`;
    try {
      const text = execFileSync('reg', ['query', key, '/s', '/f', 'Coopanion'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
      });
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:InstallLocation|DisplayIcon)\s+REG_\w+\s+(.+?)\s*$/i);
        if (!m) continue;
        registryCache.push(
          m[1]
            .replace(/^"|"$/g, '') // 去掉可能包着的引号
            .replace(/,\d+$/, '') // DisplayIcon 尾巴上的图标序号 ",0"
            .replace(/\\[^\\]+\.exe$/i, ''), // 去掉可执行文件名,只留目录
        );
      }
    } catch {
      /* 这个 hive 里没有,或者 reg 用不了,继续试下一个 */
    }
  }
  return registryCache;
}

/** 这个目录像不像一个装了桌宠素材的 Coopanion。 */
const looksRight = (root) => !!root && existsSync(join(root, PET_PKG, 'web', 'pet.html'));

/**
 * 找出 Coopanion 的安装目录:配置 > 注册表 > 常见位置。
 * @param {string} [hint] 配置或调用方给的候选(比如 petExe 所在的目录)
 * @returns {string | null}
 */
export function findCooRoot(hint) {
  for (const candidate of [hint, ...fromRegistry(), ...COMMON_ROOTS]) {
    if (looksRight(candidate)) return candidate;
  }
  return null;
}

/**
 * 给 `pet-app.js` 打补丁:加一个「跟邻居 Coo 聊天」的按钮。
 *
 * 用**字符串锚点**而不是行号——Coopanion 升级后行号一定会变,但下面这几段原文
 * 是它稳定的结构。锚点找不到就跳过并如实报告,绝不硬改:
 * 桌宠照样能用,只是少一个按钮。
 *
 * @returns {{ text: string, notes: string[] }}
 */
export function patchPetApp(src) {
  const notes = [];
  let out = src;

  /** 只在"还没打过、且锚点还在"的时候插一次。 */
  const insert = (label, marker, needle, text, after = false) => {
    if (out.includes(marker)) return void notes.push(`${label}:已有`);
    if (!out.includes(needle)) return void notes.push(`${label}:锚点没找到,跳过`);
    out = after ? out.replace(needle, needle + text) : out.replace(needle, text + needle);
    notes.push(`${label}:已打上`);
  };

  // ① prefs 里加一个 chatting:那个按钮的提示要读它
  insert(
    'chatting 字段',
    'chatting: false,',
    '  lockFrameRate: false,\n};',
    '  /** 她俩现在是不是正在聊(DSH 那份插件加的)。 */\n  chatting: false,\n',
  );
  // ② 宿主推来的 prefs 里带 chatting 时存下来
  insert(
    'chatting 同步',
    "if (typeof p.chatting === 'boolean')",
    "  if (typeof p.thinking === 'boolean') ctl.setThinking(p.thinking);\n",
    "  if (typeof p.chatting === 'boolean') prefs.chatting = p.chatting;\n",
    true,
  );
  // ③ 动作表里加那个按钮(**插在 `const ACTIONS = {` 之后**,也就是进到表里面——
  //    插到前面会变成 `cooChat: {...} const ACTIONS = {`,直接语法错误,踩过)
  insert(
    'cooChat 按钮',
    'cooChat: {',
    'const ACTIONS = {\n',
    [
      '  /**',
      '   * 跟另一只桌宠 Coo 聊天——DSH 那份插件加的(原版 Coopanion 没有)。',
      '   * 点一下把事件发回宿主,由插件决定是开聊还是暂停。',
      '   */',
      '  cooChat: {',
      '    icon: () => ICONS.chat,',
      "    state: () => (prefs.chatting ? '正在跟邻居 Coo 聊着 · 点一下让她们暂停' : '招呼邻居 Coo 过来聊两句 · 点一下开聊,再点一下暂停'),",
      "    run: () => send({ t: 'control', action: 'coo-chat' }),",
      '  },',
      '',
    ].join('\n'),
    true,
  );

  return { text: out, notes };
}

/**
 * 把页面素材准备到本插件的数据目录(仓库里不放这些文件)。
 *
 * 已经有副本就不重复拷(10 MB);但补丁每次都对一遍——Coopanion 升级后
 * 副本可能被换掉,这样它能自己修回来。
 *
 * @param {{ cooRoot: string, destDir: string, log?: (line: string) => void }} opts
 * @returns {{ ok: true, webDir: string, notes: string[] } | { ok: false, reason: string }}
 */
export function ensureAssets({ cooRoot, destDir, log }) {
  const src = join(cooRoot, PET_PKG, 'web');
  const dest = join(destDir, 'web');
  const petHtml = join(dest, 'pet.html');
  const appFile = join(dest, 'pet-app.js');

  if (!existsSync(petHtml)) {
    if (!existsSync(join(src, 'pet.html'))) return { ok: false, reason: `没在 ${src} 找到桌宠页面素材` };
    mkdirSync(dest, { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
    log?.(`页面素材已从 Coopanion 取好:${src} → ${dest}`);
  }

  let notes = [];
  try {
    const before = readFileSync(appFile, 'utf8');
    const patched = patchPetApp(before);
    notes = patched.notes;
    if (patched.text !== before) writeFileSync(appFile, patched.text);
  } catch (err) {
    notes = [`补丁没打上:${err.message}`];
  }
  return { ok: true, webDir: dest, notes };
}
