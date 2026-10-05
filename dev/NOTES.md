# 开发笔记

这份是给**改代码的人**看的:架构决策、踩过的坑、验证记录、调试脚本。
想知道怎么用的看 [README](../README.md)。

## 架构:入口是薄壳,实现是动态 import

`lib/index.js` 本身不实现任何东西,它是个**薄壳**:

```js
export function apply(ctx, config = {}) {
  const rev = Date.now().toString(36);
  void import(`./impl.js?v=${rev}`).then((mod) => mod.setup(ctx, config));
}
```

**为什么这么绕**:DSH(Cordis)按**入口模块**缓存插件。改 `impl.js` 的内容、
改 `package.json` 的 `main` 去换入口文件、`set_bundle` 关掉再打开 —— **都换不掉
已经加载过的那份代码**,只有重启 DSH 才会重新读。

给动态 import 带上 `?v=<时间戳>` 之后,每次挂载都是一个**新的模块 URL**,
于是「重载插件」就等于「拿到最新代码」。

代价:插件晚一个微任务挂载,所以入口同步返回、`setup` 是异步的。

> 同一个道理也适用于实现内部:`impl.js` 里若用静态的 `import './foo.mjs'`,
> 单独改 `foo.mjs` 同样不生效。所以本插件自己的模块**全部动态加载**
> (见 `impl.js` 里 `setup()` 开头那一段)。

## 踩过的坑

### 1. `ELECTRON_RUN_AS_NODE` 会把 Coopanion.exe 变成 Node

DSH 自己就是 Electron,会给子进程留 `ELECTRON_RUN_AS_NODE=1`。带着它去起
`Coopanion.exe --pet-host`,Electron 会按 Node 模式跑,`--pet-host` 被当成 Node
选项,直接报 `bad option`。`lib/pet-window.mjs` 里必须删掉这个变量。

### 2. Chromium profile 撞车 → 鲸鱼画不出来

Coopanion 把 pet-host 的 Chromium 档案放在 `<安装目录>\data\pet-window`。
用户自己那套 Coopanion 若正跑着,两个进程会抢同一个 GPU 缓存目录,后起的那个
**WebGL 起不来**。而窗口是全屏透明的,所以现象是「桌宠好像根本没出现」——
很难查,因为页面本身是活的、WS 也连上了,只是画不出东西。

解决:用 `CORTICO_COMPANION_DATA` 把窗口档案指到本插件自己的 `dataDir`。

### 3. DSH 会话必须先 `create` 再 `follow`

`brain-session.mjs` 里的顺序必须是 **create → follow → 等接上 → prompt**。
会话还不存在时就去挂流,流会立刻以 `session "…" not found` 断掉,之后 `prompt`
产生的事件一个都收不到,只会等超时。

### 4. `sessionController.prompt` 的 `signal` 不能省

它是 `@Remote` 方法,包装层会直接读 `signal.throwIfAborted`,传 `undefined`
会抛 `TypeError`。(反过来 `follow` 也需要一个真 signal 才能取消。)

### 5. `session` 模式下桌宠手里是有工具的

她那个会话是一个完整的 DSH agent,会拿到本插件的工具、甚至 shell。实测她会自己
调 `pet_talk` 去「问桌宠」—— 而桌宠就是她自己,于是变成自己跟自己说话。

解决:用 `ctx.tools.guard()` 挂一个全局守卫,**调用者是桌宠那个会话时一律拒绝**。
`local` 模式不走会话,不需要这道守卫。

### 6. pnpm 跨盘只能复制

插件装在 D 盘、DSH profile 在 C 盘时,pnpm 无法硬链接,会**整份复制**(约 25 MB),
而且插件在这个复制目录里跑起来后,窗口的 Chromium 缓存也堆在 C 盘。
跑 `dev/relink.ps1` 换成目录软链接即可(它按 `dsh-coo-pet*` 通配处理,可重复运行)。

### 7. 装插件时 pnpm 写 profile 的 `package.json` 可能撞 EPERM

Windows 上那个文件被 DSH 自己占着,pnpm 的 `rename` 偶尔失败,后果是
**依赖写进去了、`dsh.profile.bundles` 没写** —— 插件根本不会加载。
更麻烦的是这次失败会被 Cordis 记住,之后怎么重装都报 `failed to import`。
遇到就手动把 `bundles` 补齐;实在不行换个包名重装(新名字没有那份缓存)。

## 验证记录

| 验证项 | 怎么验的 | 结果 |
|---|---|---|
| 透明窗口 + whale 形象渲染 | CDP `Page.captureScreenshot` 抓页面 | 鲸鱼画出来了,气泡逐字打字 |
| 打字 → 大脑 → 气泡 | 看 `data/brain.jsonl` 的落盘内容 | 逐句都有对应回复 |
| 两只桌宠各用自己的气泡 | 聊天期间连拍桌面 + 查 Coopanion 的工具调用记录 | 同一句话既走 `pet_say`(她的气泡)又走 `terminal_send`(回传) |
| 跨程序跟 Coo 对话 | 直连 Coopanion 控制台终端通道 | 拿到原话,能接梗 |
| DSH 会话后端 | 一次性探针(换新包名重新加载) | `create`/`follow`/`prompt` 全通;两轮记忆正确;首轮约 4s、续轮 0.85s |
| 皮肤 / 启动键 / 气泡 | 真实桌面截图 | 正常 |

> 探针在验证途中抓到过两个致命 bug(就是上面第 3、4 条),都已修。

## 调试脚本

```powershell
# 不起 DSH,单跑服务器 + 窗口(改代码时最快)
node dev\serve.mjs --debug-port=9333

# 模拟人在桌宠上打字
node dev\poke.mjs "你好呀" --port=<服务器端口>

# 通过 CDP 问页面内部状态 / 截图(需要先带 --debug-port 起服务)
node dev\inspect.mjs "innerWidth"
node dev\inspect.mjs --screenshot=dev\page.png

# 读 DSH 的会话记录(它是 zstd 压缩的 jsonl)
node dev\read-session.mjs <session.v4.jsonl.zstd 路径>

# 只读地翻 Electron 的 asar(用来查 DSH 自己的实现)
node dev\asar.mjs find D:\dsh\resources\app.asar subagent
```

另外两个:

- `dev/oneliner-test.mjs` —— 「把回复压成一句」那条正则的测试样本;
- `dev/registry-probe.mjs` —— 单独验一遍注册表探测 Coopanion 的逻辑。
