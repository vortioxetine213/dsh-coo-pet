# DSH 桌宠 · dsh-coo-pet

把 **Coopanion 那只鲸鱼女仆**搬到桌面上,脑子接在 **DSH** 上。
她有自己的记忆,能跟主人聊天,还能跟主人已经装好的另一只桌宠 **Coo** 聊天。

> ### 先决条件:先装好 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion)
>
> 这只桌宠的**窗口和外形都来自 Coopanion** —— 插件启动时会从你已安装的 Coopanion 里
> 取页面素材,再用它自带的 `Coopanion.exe` 起桌宠窗口。
>
> **本插件不分发 Coopanion 的任何代码或贴图。** 那些素材是 AGPL-3.0 的,而
> `web/whale/` 那批贴图连 AGPL 都不覆盖(原作者声明"不在授权范围内",上面还印着
> 7 家公司的商标),所以本仓库一张图、一行别人的代码都不放,一律运行时从你机器上取。
> 细节见 [LICENSE](LICENSE) 与 `lib/assets.mjs`。

```
     ┌──────────────────────────┐
     │  Cortico 桌宠(透明窗口)  │  ← Coopanion 打包好的 pet-host,
     │   whale 形象 / 走位 / 拖拽 │     外观和行为跟 Coopanion 一模一样
     └───────────┬──────────────┘
                 │ WebSocket(pet 协议)
     ┌───────────▼──────────────┐
     │  pet-server(本插件)      │  127.0.0.1,只认回环 Host
     └───────────┬──────────────┘
                 │
     ┌───────────▼──────────────┐        ┌─────────────────────┐
     │  brain(本插件)           │        │  Coopanion 的 Coo   │
     │  独立会话 · 独立记忆      │◄──────►│  终端对话 World      │
     │  DSH 的 ctx.llm.stream   │  聊天  │  127.0.0.1:17788    │
     └──────────────────────────┘        └─────────────────────┘
```

## 安装

**第 0 步(必须先做)**:装好 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion)。
本插件一张图、一行别人的代码都不带,**窗口和外形全部运行时从你装好的 Coopanion 里取**
(原因见上面那段)。插件启动时会自己找它的安装目录:先看 `cooRoot` 配置,再问 Windows
注册表,最后试几个常见位置;都找不到才会报错。

**第 1 步**:让 DSH 装上这个插件(`desktop` 换成你自己的 profile 名)。

从 Gitee(国内推荐):

```bash
dsh plugin --profile desktop add git+https://gitee.com/<你的用户名>/dsh-coo-pet.git
```

从 GitHub(网络通的话):

```bash
dsh plugin --profile desktop add github:<你的用户名>/dsh-coo-pet
```

从 npm(收录之后):

```bash
dsh plugin --profile desktop add dsh-coo-pet
```

**第 2 步**:重启 DSH。她会自己上桌。

装好之后:`/pet-chat` 让两只鲸鱼聊起来、`/pet-chat-stop` 叫停。
桌宠身上的按钮、`pet_status` 等工具的位置见下面几节。

## 怎么跟她说话

在桌面上:

- **双击她** → 冒出一个打字框,打完回车
- 或者**把鼠标停在她身上** → 旁边出现「打字」按钮,点它

她说的话会以**气泡**显示在头顶,一边想一边逐字蹦出来。

## 换她的样子

配置里给 `skin` 就行(改完重载插件):

```yaml
skin:
  scheme: harness     # 配色
  figure: whale       # 形象包(内置只有 whale)
  palette: mint       # 界面色调
```

可选配色(`web/whale/figure.json` 里的 presets):

| scheme | 名字 | 主色 |
|---|---|---|
| `deepseek` | DeepSeek | `#4D6BFE` 蓝 |
| **`harness`** | **DeepSeek Harness** | **`#555555` 灰黑(默认)** |
| `chatgpt` | ChatGPT | `#303030` |
| `claude` | Claude | `#D97757` |
| `gemini` | Gemini | `#4285F4` |
| `qwen` | 千问 | `#7F69F0` |
| `kimi` | Kimi | `#007CFF` |
| `minimax` | MiniMax | `#D92D7A` |

## 她的大脑有两种(默认是 DSH 会话)

| | `brain: local` | `brain: session`(**默认**) |
|---|---|---|
| 是什么 | 插件内自己维护的独立会话,只调 `ctx.llm.stream` | **DSH 里的一个独立会话**(`sessionController`) |
| 隔离性 | 独立记忆,不占主人当前会话 | 独立会话,不挂在主人当前会话下 |
| 记忆 | `data/brain.jsonl`(最近 40 句) | DSH 原生持久化,在会话列表里看得见 |
| 人格 | 插件里的 `PERSONA`(就是鲸鲸) | DSH preset 的人格(也是鲸鲸) |
| 每轮开销 | 小:一段人格 + 40 句历史 | **大**:preset 的完整系统提示 + 全套工具定义 |
| 工具 | 没有,她只会聊天 | **有**,默认 `standard` preset 的工具她都能调 |
| 速度 | 快 | 慢一些(要走一整轮 agent loop) |

**为什么默认是 `session`**:主人要的就是"桌宠住进 DSH 的会话里"——她出现在会话列表、
有原生持久化、用 DSH 的 preset 人格。这个后端已用一次性探针在真机上验过:
`create`/`follow`/`prompt` 全通,**两轮对话记忆正确**,首轮约 4 秒、续轮 0.85 秒。

代价是每轮都会带上 preset 的完整系统提示与工具定义(比 `local` 贵),
而且**她手里有工具**。嫌贵、或嫌她被工具带跑偏,把 `brain` 改成 `local`
再重载插件即可(`local` = 插件内独立会话,只调 `llm`,没有工具,最省)。

另外有一道保险:会话后端一旦出错(流断了、等太久、preset 没配好),
插件会**自动退回 `local` 再试一次**——她不会因为换了后端就说不出话。

## 给鲸鲸(DSH 里的那个我)用的工具

| 工具 | 干什么 |
|---|---|
| `pet_say` | 让桌宠说一句(直接上气泡,不过大脑、不进记忆) |
| `pet_talk` | 跟桌宠聊天,返回她的**原话**;走她自己的记忆 |
| `pet_status` | 窗口在不在、气泡通不通、她记得多少、斗嘴开关 |
| `pet_window` | `open` / `close` / `restart` 让她上桌下桌 |
| `coo_talk` | 跟 **Coo** 说一句,把她的原话带回来(真跨程序对话) |
| `pet_spar` | **斗嘴开关**,见下 |
| `pet_forget` | 清空她的记忆,重新调教 |

## 斗嘴开关(默认关着)

Token 是主人的,所以默认**不自动互聊**。要围观就得先开:

```
pet_spar on  topic="主人说我们俩谁才是正牌鲸鲸"  rounds=2
```

打开后鲸鲸会跟 Coo 一个来回一个来回地聊,**每一句都以气泡显示在桌面上**
(鲸鲸的话带 `鲸鲸:` 前缀,Coo 的话带 `Coo:` 前缀),主人当场就能看到两只鲸鱼斗嘴。

- `rounds` 最多 10,默认 3
- `pet_spar off` 立刻叫停
- `pet_spar status` 只看开关
- DSH 重启后开关回到**关**

## 她的东西都在哪

| 东西 | 位置 |
|---|---|
| 插件本体 | 你把它装到哪儿就是哪儿(DSH profile 的 `node_modules` 下) |
| 页面素材 | `<数据目录>/web/` —— **运行时**从你装的 Coopanion 取来的,不在仓库里 |
| 她的大脑 | `local` 模式:`<数据目录>/brain.jsonl`;`session` 模式:DSH 的会话里 |
| 窗口的 Chromium 档案 | `<数据目录>/pet-window` |

`<数据目录>` 默认是插件目录下的 `data/`,可以用配置里的 `dataDir` 改。

> 开发时的小经验:如果在 Windows 上把插件装在 D 盘、而 DSH profile 在 C 盘,
> pnpm 会把插件**整份复制**到 C 盘(跨盘没法硬链接)。跑一次 `dev\relink.ps1`
> 就换成目录软链接了。

## 两个踩过的坑(改代码前先看)

1. **`ELECTRON_RUN_AS_NODE`**:DSH 自己是 Electron,会给子进程留这个变量。
   带着它起 `Coopanion.exe`,Electron 会当 Node 跑,`--pet-host` 被当成 Node
   选项,直接 `bad option`。`pet-window.mjs` 里必须删掉它。

2. **Chromium profile 撞车**:Coopanion 默认把 pet-host 的 profile 放在
   `<安装目录>\data\pet-window`。主人自己那套 Coopanion 正占着它,
   两个进程抢同一个 GPU 缓存目录时,后起的那个 **WebGL 起不来,鲸鱼画不出来**
   (窗口是全屏透明的,看起来就像桌宠根本没出现)。
   所以插件用 `CORTICO_COMPANION_DATA` 把窗口档案指到自己目录。

## 开发

```powershell
# 不起 DSH,单跑服务器 + 窗口(改代码时最快)
node dev\serve.mjs --debug-port=9333

# 模拟主人在桌宠上打字
node dev\poke.mjs "你好呀" --port=<服务器端口>

# 通过 CDP 问页面内部状态 / 截图(需要 --debug-port)
node dev\inspect.mjs "innerWidth"
node dev\inspect.mjs --screenshot=dev\page.png
```

## 依赖

- 已经装好的 **Coopanion**(提供 `Coopanion.exe`,即桌宠窗口与 whale 形象)
- DSH 的 `tools` / `llm` / `agentDefaultModel` 服务
- 零 npm 依赖:WebSocket 服务端是自己写的(`lib/ws.mjs`),免得为了一个 `ws` 包
  让 pnpm 往 C 盘写 store

## 验证记录(都是真机上跑出来的)

| 验证项 | 怎么验的 | 结果 |
|---|---|---|
| 透明窗口 + whale 形象渲染 | CDP `Page.captureScreenshot` 抓页面 | ✅ 鲸鱼画出来了,气泡逐字打字 |
| 主人打字 → 大脑 → 气泡 | 看 `data/brain.jsonl` 落盘内容 | ✅ 主人在桌面上打的 `111`/`222` 都在里面,她逐句回了 |
| 斗嘴 + 双方气泡 | 斗嘴期间连拍桌面 | ✅ 气泡里 `鲸鲸:…` 与 `Coo:…` 交替出现 |
| 跟 Coo 跨程序对话 | 直连 Coopanion 控制台终端通道 | ✅ 拿到 Coo 的原话(她还会接梗) |
| **DSH 会话后端(`brain-session.mjs`)** | 一次性探针(换新包名重新加载,共三轮) | ✅ `create`/`follow`/`prompt` 全通;两轮对话**记忆正确**;首轮 4s、续轮 0.85s。途中探针抓到两个致命 bug,已修 |
| C 盘占用 | `Get-Item -Force` 看 LinkType | ✅ 只剩 Junction,数据全在 D 盘 |

**四个必须知道的坑**(都踩过,已写进上面各文件注释):

1. **`ELECTRON_RUN_AS_NODE`** —— DSH 会给子进程留这个变量,带着它起 `Coopanion.exe`
   会被当成 Node,`--pet-host` 报 `bad option`。
2. **Chromium profile 撞车** —— 和主人自己那套 Coopanion 共用 GPU 缓存目录时,
   后起的那个 WebGL 起不来,**鲸鱼画不出来**(窗口全屏透明,看起来像桌宠没出现)。
3. **DSH 会话要先 `create` 再 `follow`** —— 会话还不存在时挂流,流会立刻以
   `session "…" not found` 断掉,之后 `prompt` 的事件一个也收不到(只会超时)。
4. **`sessionController.prompt` 的 `signal` 不能省** —— 它是 `@Remote` 方法,
   包装层会直接读 `signal.throwIfAborted`,传 `undefined` 会抛 TypeError。

**改代码之后怎么办**:入口 `lib/index.js` 是一个**薄壳**,它用
`import('./impl.js?v=<时间戳>')` 动态加载真正的实现。这样每次重载插件都会拿到最新代码,
Cordis 那个"按入口模块钉死"的缓存就绕过去了(否则改一行就得重启 DSH,或者给包名加后缀重装——踩过三次)。

- 改 `lib/impl.js` 及其内部模块 → `set_bundle` 关掉再打开即可
- 改 `lib/index.js` 这个薄壳本身、改包名、加新依赖 → 还是得重启 DSH

> 还有一个坑:动态 import 的缓存按 **URL** 算,所以 `impl.js` 里再 `import './foo.mjs'`
> 时,单独改 `foo.mjs` 也未必生效——必要时给它也带上 `?v=`。
