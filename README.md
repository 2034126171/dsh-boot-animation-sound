# dsh-boot-animation-sound

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加一段**开机动画**：启动时铺满窗口播放一段视频。

**和别的开机动画比，这一版只改一件事：声音不需要全屏。**

纯 JavaScript，没有构建步骤。

---

## 为什么需要它

参考社区里几个开机动画，它们的做法是：

> 浏览器禁止带声音自动播放 → 动画一律**静音起播** → 想听声音就**点一下画面** →
> 但那一按**同时还会 `requestFullscreen()`**，于是「开声音」和「进全屏」被绑成了同一个动作。

（`dsh-boot-animation-pro` 的 README 自己就是这么写的：**点一下画面即可开启声音并进入全屏**。）

本插件把这两件事**拆开**：

| 动作 | 常见的绑定式做法 | 本插件 |
|---|---|---|
| 起播 | 一律静音 | `sound: true` 时**先试带声音起播** |
| 被系统拦下 | 静音播放，等点击 | 静音播放，等点击（一样） |
| 点一下画面 | **开声 + 进全屏** | **只开声**，窗口大小一动不动 |
| 第一次点击/按键 | 必须点在画面上 | 窗口内**任意位置**的第一次点击/按键就开声 |
| 进全屏 | 开声的副作用 | 只有那个**默认关闭**的「全屏」按钮才会进 |

代码层面：`client.js` 里 `requestFullscreen()` **只出现一次**，就在全屏按钮的事件处理函数里；
开声那条路径（`unlock`）只做两件事：`video.muted = false` 和 `video.play()`。
这条约束由验证脚本静态断言，改坏了跑测试就会红。

## 声音到底能不能自动响

先说规则。这个结论是在真实环境里**实测**出来的，不是照抄文档：

- 在一个**没有任何用户手势**的页面里，非静音的 `play()` 会被 Chromium 拒绝（`NotAllowedError`）。
  Electron 的默认自动播放策略本应是 `no-user-gesture-required`，但**实测就是拒绝了**，
  所以本插件按「会被拒绝」来设计，而不是赌它不拒绝。
- 一旦这个页面**有过用户手势**（哪怕只是之前随便点过一下），非静音播放就会被放行。

于是分三种情况，插件三种都实现了：

1. **平台放行** → **直接就有声音**，一次都不用点。
2. **平台拦下** → 画面照常播，右下角出现一个「🔊 点这里开声（不用全屏）」的小按钮；
   **同时**你在窗口里**随便点一下或按一下键盘**也会开声。同一个窗口，不进全屏。
3. **设置里关掉声音** → 连试都不试，静音播放，也不出现任何开声提示。

> 想彻底免点击，只能改平台策略本身（例如给 Electron 传
> `--autoplay-policy=no-user-gesture-required`），那不是插件能做的事。
> 本插件能做的是：**不让你用全屏去换声音**，并把「要点的那一下」缩到最小——点哪都行。

### 实测记录

真实窗口里跑过一次之后，插件自己写下的 `last-boot.json`（原文摘录）：

```json
{
  "audio": "on",                    // 有声播放
  "muted": false,                   // 元素没被静音
  "audioDecodedBytes": 115835,      // 真的解码出 115 KB 音频，声音确实出来了
  "fullscreen": false,              // 没有全屏
  "fullscreenEverRequested": false, // 全程没请求过全屏
  "duration": 7.05, "videoWidth": 1280, "videoHeight": 720,
  "ua": "… @deepseek-ai/dsh-desktop/0.2.0-rc.2 Chrome/152.0.7977.54 Electron/44.0.0 …"
}
```

`audioDecodedBytes` 是关键：它说明音频**真的被解码并送进了输出管线**，而不是「元素说自己没静音」而已。

## 只在「一次页面加载」时播放

开机动画属于**一次页面加载**，不属于「插件被加载的那一刻」。
DSH 的 client 模块图是活的——把插件当场启用、或 HMR 把模块塞进一个开着很久的页面，都会加载这个文件。
所以浏览器半会先判断这是不是属于本次加载：

- 宿主在服务端 HTML 里注入的首帧遮罩**在 `<head>` 里**——它在，就是本次加载（精确信号）；
- 遮罩关掉时（`coverApplication: false`）退回用**页面年龄**判断：模块在页面开了几分钟后才到，那一定是热加载，不播。

这样正常启动照常播，而不会突然盖住你正在干活的窗口。

## 安装

profile 目录是 `<DSH_HOME>/profiles/<profile 名>`（`<DSH_HOME>` 未设置时默认 `~/.dsh`）。

**方式一：让 agent 用 `plugin_manager` 装（桌面版首选）**

```
plugin_manager: action=install_bundle, target=github:2034126171/dsh-boot-animation-sound
```

**方式二：命令行**

```bash
npm install -g @deepseek-ai/dsh
dsh plugin --profile web add github:2034126171/dsh-boot-animation-sound
```

**方式三：手动**

1. 在 profile 目录的 `package.json` 里，`dependencies` 加
   `"dsh-boot-animation-sound": "github:2034126171/dsh-boot-animation-sound"`；
2. 把 `"dsh-boot-animation-sound"` 加进同一个文件的 `dsh.profile.bundles` 数组；
3. 在该目录里用 pnpm 执行 `install`（桌面版自带 pnpm，在 `<DSH_HOME>/.desktop-bin/pnpm.cmd`）；
4. 重启 DSH。

> 通过 GitHub 安装需要本机装有 `git`。

> **开发机上的现状**（与使用者无关，仅供本仓库作者参考）：源码放在工作区，profile 用两个 junction
> 指过来（`profiles/node_modules/…` 与 `profiles/desktop/node_modules/…`；前者给依赖 spec 用，因为它没有空格），
> 并在 `dsh.profile.bundles` 里列了包名；改 profile `package.json` 之前已备份为
> `package.json.before-dsh-boot-animation-sound.bak`。

## 使用

设置页在 **设置 → 插件 → 开机动画**：

| 项 | 说明 |
|---|---|
| 播放影片声音 | 这个插件的主角。默认**开**。关掉＝整段动画静音，也不再出现开声提示 |
| 音量 | 0–100% |
| 首次点击/按键自动开声 | 默认**开**。关掉后只能点右下角那个开声按钮 |
| 启动时显示动画 | 临时关掉动画，但保留已选路径 |
| 显示全屏按钮 | 默认**关**。和声音毫无关系：开声永远不会触发它 |
| 退出方式 | 右下角按钮 / 点任意位置 / 自动退出 / 不能退出 |
| 视频文件 | 路径输入框 + 「选择文件…」原生对话框 + 保存 / 清除 |

「清除」＝**不再播放**，DSH 启动起来和没装这个插件时一模一样。

### 保命键

**`Esc` 永远能退出动画**，任何退出方式下都生效。全屏层吞得掉鼠标点击，吞不掉键盘。
一个铺满屏幕、又关不掉的面板离「软件没法用」只差一个 bug，所以这个键是无条件保留的。

## 出问题怎么看

每次真实启动的结果都会写进：

```
<DSH_HOME>/dsh-boot-animation-sound/last-boot.json
```

设置页底部也会显示一行摘要。关键字段：

| 字段 | 含义 |
|---|---|
| `audio` | `on` 有声播放 / `off` 按设置静音 / `blocked` 被系统拦下（点一下就能开）/ `error` 播放失败 |
| `muted` | 那一刻元素是否静音 |
| `audioDecodedBytes` | **音频真的被解码出来的字节数**。`> 0` 说明视频有音轨、音频管线真的跑了；`0` 说明这段视频根本没声音 |
| `fullscreen` | 那一刻是否处于全屏 |
| `fullscreenEverRequested` | 本次启动是否请求过全屏（正常情况下永远是 `false`） |
| `userActivation` | 当时的用户激活状态 |

排查顺序：先看 `audioDecodedBytes` 是不是 0（是 0 → 换一个带音轨的视频），
再看 `audio` 是不是 `blocked`（是 → 点一下窗口任意位置，或确认「首次点击/按键自动开声」是开的），
最后看 `muted` 和音量。

## 配置（可选）

也可以直接改 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-boot-animation-sound
  config:
    src: D:/videos/boot.mp4   # 留空字符串 = 不播；不写 = 用自带视频
    sound: true
    volume: 0.9
    fit: cover                # cover 铺满裁切 / contain 完整留边 / fill 拉伸
    skip: button              # button / click / auto / never
    fadeOutMs: 360
    showFullscreenButton: false
```

设置页里改过的项会盖在 patch 上面（存在 `<DSH_HOME>/dsh-boot-animation-sound/settings.json`）。
字段写错只会退回默认值，不会导致启动失败。完整字段见 `index.js` 里的 `DEFAULTS`。

## 验证

```bash
npm run verify
```

169 项检查，**全部不依赖 DSH、不依赖浏览器**，也不需要安装任何依赖：

- `verify/check-media.mjs`（6 项）：`media/` 里的片段是否真的是视频容器、**是否带音轨**。
  自带视频没声音的话这个插件就没意义了，所以这一条是硬检查。
- `verify/host-verify.mjs`（102 项）：跑**宿主半**的真实代码——配置归一化、媒体解析、
  五个 HTTP 路由（含 `Range` 取字节）、设置保存、开机报告落盘、首帧遮罩注入，
  以及静态断言：「`requestFullscreen()` 只有一个调用点且在按钮里」、「结束时什么都不画」、
  「没有任何 effect 还只依赖 `active`」。
- `verify/client-smoke.mjs`（61 项）：用一个迷你 React + 假 DOM + 假 `<video>` +
  **可切换的自动播放策略**（复现真实环境那个 `NotAllowedError`）把**浏览器半**真跑一遍：
  带声起播 → 被拒 → 静音兜底 → 出现开声提示 → 第一次点击开声 → **全程零次 `requestFullscreen()`**；
  热加载进老页面时**不播**；以及收场回归测试（跳过 / 播完 / `Esc` 都要让出屏幕）。
  这个迷你 React 会**真的调用上一次的 effect 清理函数**——清理函数要是被丢掉，
  组件漏掉监听器也能「通过」，那这些测试就没有意义了。

> **变异验证（一次性做过）**：把 `if (!running) return null` 换回
> `if (!active) return null`，`client-smoke.mjs` 立刻 2 项失败，失败详情里正是那个
> `position: fixed; inset: 0; z-index: 2147483000` 的盒子和「正在加载视频…」。
> 测试对着它命名的缺陷会红，才叫回归测试。

## 已修过的严重缺陷

**动画结束后整个界面点不动。** 覆盖层是铺满视口的固定定位盒子，而槽位注册表会让组件在整个页面
生命周期里保持挂载；原来的渲染判断只看了「该不该播」，没看「还在不在播」，于是播完之后那层
**透明但仍在最上面**的盒子继续吃掉每一次点击。修法是把「该不该播」和「现在还在不在播」分开，
并让所有 effect 跟着它走，另加三道独立保险（`pointerEvents` 随淡出放行、10 分钟硬上限、
`Esc` 无条件可退出）。完整来龙去脉见 [CHANGELOG.md](CHANGELOG.md)。

## 素材与权利

`media/default2.mp4` 是**示例片头**，**不在下面的 MIT 授权范围内**，其权利归属请自行确认；
要公开分发请先换成你拥有权利的素材（替换该文件即可，不需要改代码）。

`verify/check-media.mjs` 会检查它带不带音轨——**视频必须自带音轨**，否则声音那一栏没有任何东西可放。

## 许可

MIT，覆盖插件代码（见 [LICENSE](LICENSE)）。素材例外见上一节。
