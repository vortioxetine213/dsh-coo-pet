# dsh-coo-pet

[English](README.md) | **简体中文**

把 [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) 的桌宠接进 **DeepSeek Harness (DSH)**。

她住在你的桌面上，大脑是 DSH 里的一个**独立会话** —— 有自己的记忆，能跟你聊天，
也能跟 Coopanion 里那只 **Coo** 聊天：两只桌宠各说各的，各自用**自己的气泡**说话。

```
     ┌──────────────────────────┐
     │  Coopanion 的桌宠窗口    │  透明、置顶、点击穿透;
     │  whale 形象 / 走位 / 拖拽 │  由 Coopanion 自带的 pet-host 提供
     └───────────┬──────────────┘
                 │ WebSocket(pet 协议)
     ┌───────────▼──────────────┐
     │  pet-server(本插件)      │  127.0.0.1,只认回环 Host
     └───────────┬──────────────┘
                 │
     ┌───────────▼──────────────┐        ┌─────────────────────┐
     │  brain(本插件)           │        │  Coopanion 的 Coo   │
     │  独立会话 · 独立记忆      │◄──────►│  终端对话 World      │
     └──────────────────────────┘        └─────────────────────┘
```

## 先决条件:必须先装 Coopanion

桌宠的**窗口和外形全部来自 Coopanion**,本插件在运行时从你已安装的那份里读取:
它去 `cortico-world-desktop-pet/web/` 取页面与形象素材,并用 `Coopanion.exe --pet-host`
起桌宠窗口。**不装 Coopanion,就没有形象、也没有窗口。**

**本插件不分发 Coopanion 的任何代码或贴图。** 那些素材是 AGPL-3.0 的,而
`web/whale/` 的贴图连 AGPL 都不覆盖 —— 原作者在 `THIRD_PARTY_NOTICES` 里明确写了
"不在本包的 AGPL 授权范围内",而且围裙上印着 DeepSeek、OpenAI、Anthropic、Google、
阿里云、月之暗面、MiniMax 的商标。所以本仓库一张图、一行别人的代码都不放,
一律运行时从用户自己的安装里取。细节见 [LICENSE](LICENSE) 与 `lib/assets.mjs`。

插件会自己找 Coopanion 的安装目录:先看 `cooRoot` 配置,再问 Windows 注册表,
最后试几个常见位置;都找不到才会报错并提示你在配置里指定。

## 安装

`desktop` 换成你自己的 DSH profile 名。

```bash
# 从 GitHub
dsh plugin --profile desktop add github:vortioxetine213/dsh-coo-pet

# 或从 npm(收录之后)
dsh plugin --profile desktop add dsh-coo-pet
```

装完**重启 DSH**,她会自己上桌。

## 用法

**跟她说话**:双击她,或者把鼠标停在她身上点旁边冒出来的「打字」按钮。
她的话会以气泡显示在头顶,一边想一边逐字蹦出来。

**让她跟 Coo 聊天**:两个入口,都不烧到你想停为止。

| 入口 | 怎么写 |
|---|---|
| DSH 输入框 | `/pet-chat` 开聊、`/pet-chat-stop` 叫停 |
| 桌宠身上 | 鼠标停在她身上,点那个「跟 Coo 聊天」按钮 —— **同一个键管开关**,再点一下暂停 |

`/pet-chat` 还能带参数:

```
/pet-chat 5 今天谁摸鱼摸得多    # 聊 5 个来回,并给个开场话题
/pet-chat 0                    # 一直聊到你喊停
```

> 默认**关着**,不会自动开聊 —— 互聊时两边都在调模型,是要花 token 的。

## 配置

都在 `cordis.patch.yml` 里,改完重载插件生效。一般只有前两个需要动。

| 键 | 说明 |
|---|---|
| `cooRoot` | Coopanion 的安装目录。默认自动探测 |
| `brain` | `session`(默认)= 她的大脑是 DSH 里的独立会话;`local` = 插件内自建会话,**没有工具、最省 token** |
| `skin.scheme` | 配色:`deepseek` / `harness` / `chatgpt` / `claude` / `gemini` / `qwen` / `kimi` / `minimax` |
| `chatRounds` | 上面那个按钮和不带数字的 `/pet-chat` 默认聊几个来回(最多 10) |
| `user` | 她怎么称呼你,默认「主人」 |
| `autoStart` | 装上就上桌,默认 `true` |
| `port` | 桌宠页面服务器端口,默认让系统分配 |
| `petExe` | `Coopanion.exe` 的路径,默认取 `cooRoot` 下的 |
| `dataDir` | 她的数据放哪(记忆、窗口档案、取来的素材),默认插件目录下的 `data/` |

### 两种大脑的区别

| | `local` | `session`(默认) |
|---|---|---|
| 记忆 | `data/brain.jsonl`,最近 40 句 | DSH 原生持久化,会话列表里能翻到 |
| 人格 | 插件内置的鲸鲸人设 | DSH 的 preset 人格 |
| 每轮开销 | 小(一段人设 + 40 句历史) | 大(preset 的完整系统提示 + 工具定义) |
| 工具 | 没有,她只聊天 | **有**,她那个会话会拿到 DSH 的工具 |
| 速度 | 快 | 慢一些(要走一整轮 agent loop) |

`session` 模式下有一条**保险**:会话后端一旦出错(流断了、等太久、preset 没配好),
插件会自动退回 `local` 重试一次 —— 她不会因为换了后端就说不出话。

## 给 DSH 里的 AI 用的工具

装好之后,你的 AI 会多出这些工具:

| 工具 | 干什么 |
|---|---|
| `pet_say` | 让桌宠说一句(直接上气泡,不过大脑、不进记忆) |
| `pet_talk` | 跟桌宠聊天,返回她的原话 |
| `pet_status` | 看她现在的状态:窗口、气泡、记忆条数、聊天开关 |
| `pet_window` | `open` / `close` / `restart` 让她上下桌 |
| `coo_talk` | 跨程序跟 Coopanion 的 Coo 说一句,把她的原话带回来 |
| `pet_spar` | 上面那个聊天开关(工具版) |
| `pet_forget` | 清空她的记忆 |

## 常见问题

**装完没有桌宠。**
99% 是没找到 Coopanion。先确认它确实装了,然后在 `cordis.patch.yml` 里写明确路径:

```yaml
config:
  cooRoot: 'D:\你的\Coopanion'
```

**窗口出来了但是空的(没有鲸鱼)。**
极可能是 Chromium profile 撞车:Coopanion 默认把 pet-host 的档案放在
`<安装目录>\data\pet-window`,如果它自己的桌宠正跑着,两个进程抢同一个 GPU 缓存目录,
后起的那个 WebGL 起不来。本插件已经用 `CORTICO_COMPANION_DATA` 把窗口档案指到自己的
`dataDir` 了 —— 如果你改过这个变量,检查一下别指回 Coopanion 的目录。

**她说话很长、还爱分条列点。**
插件在出气泡之前会强制压成一句(去换行、剥编号、超 80 字截断);如果还是长,
把 `brain` 换成 `local`,内置人设里对长度管得更严。

## 许可

代码是 [MIT](LICENSE)。**Coopanion 的素材不在本项目的授权范围内**,见上面「先决条件」,
以及 [LICENSE](LICENSE) 末尾那段说明。

## 开发

见 [dev/NOTES.md](dev/NOTES.md) —— 里面有架构决策、踩过的坑、验证记录和调试脚本的用法。
