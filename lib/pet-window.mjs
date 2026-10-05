/**
 * 桌宠窗口:用已经装好的 Coopanion 的 pet-host,起一个透明、置顶、点击穿透的窗口。
 *
 * 复用的是 Coopanion 打包好的 Electron 主进程(`Coopanion.exe --pet-host`),
 * 所以桌面上那只鲸鱼的外观、走位、拖拽、动作全都和 Coopanion 一模一样;
 * 不一样的只是它连的服务器——这里是 DSH,不是 Cortico 的 core。
 *
 * 两个坑,都踩过:
 * 1. DSH 自己是 Electron,给子进程留了 `ELECTRON_RUN_AS_NODE=1`。带着它起
 *    Coopanion.exe,Electron 会当 Node 跑,`--pet-host` 会被当成 Node 选项,
 *    直接报 `bad option`。必须删掉。
 * 2. Coopanion 默认把 pet-host 的 Chromium profile 放在它安装目录的
 *    `data\pet-window`。主人自己那套 Coopanion 正占着这个目录,两个进程抢同一个
 *    GPU 缓存目录时后起的那个 WebGL 起不来——鲸鱼画不出来(全屏透明)。
 *    所以这里用 `CORTICO_COMPANION_DATA` 指到本插件自己的数据目录。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Coopanion 的默认安装位置;配置里可以改。 */
export const DEFAULT_EXE = 'D:\\deepseek\\Coopanion\\Coopanion.exe';

export class PetWindow {
  /**
   * @param {object} opts
   * @param {string} opts.exe Coopanion.exe 的路径
   * @param {() => string} opts.url 返回 pet 页面地址
   * @param {string} opts.dataDir 本插件的数据目录(给窗口的 Chromium profile 用)
   * @param {(line: string) => void} [opts.onLog] 窗口进程的输出
   * @param {() => void} [opts.onExit]
   */
  constructor(opts) {
    this.opts = opts;
    this.child = null;
    /** 上一轮的失败原因,状态查询用。 */
    this.detail = null;
  }

  get running() {
    return this.child !== null;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  start() {
    if (this.child) return true;
    const exe = this.opts.exe || DEFAULT_EXE;
    if (!existsSync(exe)) {
      this.detail = `找不到桌宠窗口程序:${exe}(装好 Coopanion,或在插件配置里改 petExe)`;
      return false;
    }
    const url = this.opts.url();
    if (!url) {
      this.detail = '桌宠服务器还没起来';
      return false;
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    env.CORTICO_COMPANION_DATA = this.opts.dataDir;
    try {
      this.child = spawn(exe, ['--pet-host', `--pet-url=${url}`, `--parent-pid=${process.pid}`], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
      });
    } catch (err) {
      this.detail = `桌宠窗口起不来:${err.message}`;
      return false;
    }
    this.detail = null;
    const forward = (d) => {
      for (const line of String(d).split(/\r?\n/)) if (line.trim()) this.opts.onLog?.(line.trim());
    };
    this.child.stdout?.on('data', forward);
    this.child.stderr?.on('data', forward);
    this.child.on('error', (err) => {
      this.detail = err.message;
    });
    this.child.on('exit', (code) => {
      this.child = null;
      this.opts.onLog?.(`桌宠窗口退出(退出码 ${code})`);
      this.opts.onExit?.();
    });
    return true;
  }

  /** 关掉窗口,最多等 3 秒,然后强杀。 */
  async stop() {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;
    const exited = new Promise((r) => child.once('exit', () => r()));
    child.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    if (child.exitCode === null && child.pid) {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }
  }
}
