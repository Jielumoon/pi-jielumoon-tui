# pi-jielumoon-tui

一个面向 [Pi](https://github.com/badlogic/pi-mono) coding agent 的 TUI 扩展。

本项目以 [`pi-vibrant-footer`](https://github.com/Jielumoon/pi-vibrant-footer) 为功能基线，保留 Footer、上下文、usage、Blackhole 和设置系统，同时加入 Sakura 风格的 Thought trail 与工作状态 Shimmer。

## 特性

### Footer 与上下文

- 路径、分支、会话、Provider、Model、Thinking level
- 上下文用量彩条、百分比和 token 窗口
- 输入/输出 token、缓存读写、缓存命中率和费用
- 会话耗时、扩展状态以及 Blackhole O/R/P/C 指标
- 保留原版 Footer 的显示设置和持久化配置
- 彩条使用背景色块渲染，低用量时仍保持稳定布局
- 订阅额度作为会话统计的一部分，紧跟费用 / `sub`、位于会话时长前；周窗口统一显示为 `7d`

### Thought trail

- 使用 `✦ Thought trail · N steps` 展示思考步骤
- 保留 `├─ ◇` / `╰─ ◇` 树形结构
- 支持折叠思考内容的简洁预览
- 与工具块保持一致的左侧对齐

### Sakura 消息样式

- 用户消息使用 Sakura 风格边框和 macaron Markdown 配色
- 工具调用与 Bash 执行使用卡片边框和状态提示
- 助手正文与 Thought trail 保持干净的无包围框布局

### Sakura 输入框

- Pi 原生编辑器外包一层 Sakura macaron 圆角框
- 保留补全、粘贴、历史、Esc 中断和全部 Pi 快捷键
- 窄终端自动回退原生样式；发现其它扩展已接管 Editor 时自动让位

### 工作状态 Shimmer

- 工作中使用 Pi 原生 Braille spinner：
  `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`
- 工作文案为 `Working (Ns · esc to interrupt)`
- Working、retry countdown 和 context compaction 共用 Thought trail 的 Sakura macaron 色板
- 渐变以较慢的节奏移动，spinner 仍保持独立的原生转圈速度
- agent 完成后追加与 Thought trail 对齐的 `Worked for Ns` transcript 行

输入框使用 Sakura 圆角框；工具内容仍由 Pi 原生组件负责，只增加消息卡片样式。

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
```

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
