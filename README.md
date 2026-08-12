# pi-jielumoon-tui

一个面向 [Pi](https://github.com/badlogic/pi-mono) coding agent 的 TUI 扩展。

本项目以 [`pi-vibrant-footer`](https://github.com/Jielumoon/pi-vibrant-footer) 为功能基线，保留 Footer、上下文、usage、Blackhole 和设置系统，并以 Sakura Quiet 视觉语言统一消息、工具与工作状态。Thought trail 保持原有 Sakura 树形设计。

## 特性

### Footer 与上下文

- 第一行以稳定左右锚点展示路径、分支、会话与 Provider、Model、Thinking level
- 第二行展示输入/输出 token、缓存、费用、订阅额度与会话耗时
- 上下文使用 8–20 列前景色 compact gauge，不再绘制全宽背景色块或在 Footer 重复百分比
- Blackhole 有可用快照时始终显示；扩展与 planning 仍仅在活动或异常时增加状态行
- 保留原版 Footer 的显示设置和持久化配置
- 订阅额度紧跟费用 / `sub`；周窗口统一显示为 `7d`

### Thought trail

- 使用 `✦ Thought trail · N steps` 展示思考步骤
- 保留 `├─ ◇` / `╰─ ◇` 树形结构
- 支持折叠思考内容的简洁预览
- 与工具块保持一致的左侧对齐

### Sakura 消息样式

- 用户消息使用无标题 Sakura 完整圆框，粉色粗 `▌` rail 位于框内，和工具状态卡保持明确区别
- read 保持无框并左缩进 2 格；其它工具把唯一 canonical header 嵌入 Sakura 上边框，溢出时以 `…` 收束并始终保留右侧封口横线
- 工具框默认剥离 Pi 默认背景色；可通过“工具状态底色”开关恢复按运行状态变化的主题底色，Read 和图片旁路保持无底色
- Read 默认单行；Edit 流式期间逐字展示伪 diff（操作标签 + 红减绿加），完成后换真实 diff；Write 真实跟随参数流自适应逐字显示，默认保留末尾 8 个终端行，常规内容自动语法高亮、超大内容安全回退纯文本；Bash 成功显示尾部摘要、失败保留错误 rail；Ctrl+O 展开完整内容
- 助手正文与 Thought trail 保持干净的无包围框布局

### Sakura 输入框

- Pi 原生编辑器外包一层 Sakura macaron 圆角框
- 保留补全、粘贴、历史、Esc 中断和全部 Pi 快捷键
- 小于 7 列时安全回退原生 Editor，避免双宽字符与光标触发换行递归；发现其它扩展接管 Editor 时自动让位

### 工作状态

- 工作中使用 Pi 原生 Braille spinner：
  `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`
- Working、运行中工具、retry 与 compaction 共享 Sakura macaron Braille spinner；其它文字保持静止
- retry countdown 与 context compaction 同样只动画 spinner，避免整句 shimmer
- 5 秒以内任务不写 transcript；长任务完成后追加 dim `· Ns`

输入框保留 Sakura 圆角框；工具执行逻辑保持 Pi/readmap 原样，本扩展只接管 renderer 与折叠展示。

## 安装

直接从 GitHub 安装：

```bash
pi install https://github.com/Jielumoon/pi-jielumoon-tui
```

本地开发或测试：

```bash
pi install /home/jielumoon/opt/projects/pi-tui/pi-jielumoon
```

也可以临时加载，不写入安装配置：

```bash
pi -e /home/jielumoon/opt/projects/pi-tui/pi-jielumoon
```

更新扩展后，在 Pi 中执行：

```text
/reload
```

## 命令

加载扩展后，使用 `/jielumoon-tui` 管理 Footer：

```text
/jielumoon-tui                       打开显示设置
/jielumoon-tui settings              打开显示设置
/jielumoon-tui on                    启用 Jielumoon Footer
/jielumoon-tui off                   恢复 Pi 默认 Footer
/jielumoon-tui toggle                切换 Footer 开关
/jielumoon-tui tool-bg on          显示有框工具的状态底色
/jielumoon-tui tool-bg off         隐藏有框工具的状态底色
/jielumoon-tui write-animation on   开启 Write 自适应逐字动画
/jielumoon-tui write-animation off 关闭动画但保留末尾 8 行预览
/jielumoon-tui edit-animation on    开启 Edit 伪 diff 逐字动画
/jielumoon-tui edit-animation off  关闭动画但保留静态伪 diff 预览
/jielumoon-tui reset                 恢复默认显示项
/jielumoon-tui planning on           显示右侧计划阶段状态
/jielumoon-tui planning off          隐藏右侧计划阶段状态
/jielumoon-tui usage off            隐藏扩展状态与订阅额度
```

也可以直接切换单项：

```text
/jielumoon-tui context off
/jielumoon-tui cache on
/jielumoon-tui blackhole off
/jielumoon-tui plan off
/jielumoon-tui write-animation off
```

其中 `context` 开关直接控制 Editor 下方的 Nano context 紧凑用量条，不再是无效的 Footer 遗留选项。

`tool-bg` 只在 color 模式下生效：底色由对应状态 rail 的马卡龙色相按同一比例压进墨底派生——运行雾蓝、成功雾绿、失败雾玫瑰、取消雾奶油，卡内底色与左侧 rail 呼应，不随宿主主题变化（宿主主题的 `tool*Bg` 质量参差，例如 catppuccin-mocha 是近黑/灰且成功失败同色）。
也可直接在该 JSON 中设置 `"toolBackground": true`。

`write-animation` 默认开启，仅控制逐字过渡（无光标）；关闭后 Write 仍实时展示末尾 8 个终端显示行。8 KiB 以内的可识别文件自动语法高亮，超过上限时回退纯文本尾部，避免高亮器冻结 TUI。也可在同一 JSON 中设置 `"writeAnimation": false`。plain、screen-reader 与 `NO_COLOR` 模式始终使用静态预览。

`edit-animation` 默认开启：Edit 参数流式期间按操作展示伪 diff——`┄` 操作标签（含 `LINE:HASH` 锚点）、红 `▌-` 旧文本、绿 `▌+` 新文本，逐字揭示（无光标），折叠态保留尾部 8 行；工具完成后由真实 diff 替换。流式期间没有真实行号，红绿行只反映参数内容。也可在同一 JSON 中设置 `"editAnimation": false` 保留静态伪 diff 预览。

设置会保存到 Pi agent 目录的 `pi-vibrant-footer.json`，用于兼容原版 Footer 配置。默认路径通常是：

```text
~/.pi/agent/pi-vibrant-footer.json
```

## 开发

要求 Node.js 22.19.0 或更高版本。

```bash
npm install --legacy-peer-deps
npm test
npm run typecheck
npm run pack:check
npm audit --omit=dev
```

扩展资源由 `package.json` 的 `pi.extensions` 声明：

- `src/index.ts`：唯一自有入口，统一注册 nano-context、Footer、Thought trail、消息样式、Sakura 输入框、工作状态和自研订阅用量

## 兼容性

- Node.js `>=22.19.0`
- `@earendil-works/pi-coding-agent >=0.83.0`
- `@earendil-works/pi-tui >=0.83.0`
- `@earendil-works/pi-ai >=0.83.0`

### 自研订阅用量

Footer 会按当前模型在左侧会话统计中显示 Codex、Claude、OpenRouter 或 Grok 的额度：它紧跟费用 / `sub`，位于会话时长前，例如 `… · 13.162 sub · 7d 37% ↻ 1d · 1m25s`。`/usage` 可强制刷新当前账户的简要详情。成功结果缓存 60 秒，失败遵守 Retry-After 和退避时间；自定义代理模型不会把凭证发送到官方额度接口。

支持的额度接口来自各 Provider 的官方/客户端用量端点，认证使用 Pi 当前 ModelRegistry 解析的凭证。Codex、Claude、Grok 需要 OAuth 账户，OpenRouter 使用当前 API key。

Pi 核心包由宿主提供，不会被重复打包；订阅用量只使用本扩展内的四个 Provider 适配器。

## 许可证

[MIT](./LICENSE)
