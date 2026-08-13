# Findings & Decisions: Write 实时逐字可视化

## Confirmed Requirements

- 动画来源：真实跟随模型生成 `write.content`，禁止写入完成后的假回放。
- 动画节奏：自适应逐字；小积压逐字符，大积压自动加速；参数完成立即补齐。
- 默认窗口：末尾 8 个终端显示行，自动跟随内容末尾。
- 高亮：按路径扩展名自动语法高亮，未知类型退回纯文本。
- gutter：只显示弱色真实行号，不显示 hashline 哈希。
- 光标：亮色细竖线 `▏`，仅动画运行期间存在。
- 标题：路径 + 当前已显示行数。
- 创建成功：继续展示最终末尾 8 个显示行。
- 覆盖成功：从实时新内容切换为变更 diff。
- 失败/中断：保留最后 8 个显示行并明确标记未完成/写入失败。
- 外观：保留现有 Sakura 工具完整外框。
- 展开：运行中和完成后都支持 `Ctrl+O`；展开显示全部内容，不保留 12/200 行上限。
- 并行：所有 write 独立动画，底层共享刷新节拍。
- 设置：默认开启；菜单 `Write 逐字动画`；命令别名 `write-animation`；字段 `writeAnimation`。
- 动画关闭：仍实时展示末尾 8 行，只取消逐字过渡和光标，彻底淘汰旧空框。

## Codebase Findings

### Current extension behavior

- `src/readmap-renderers.ts` 接管 `read/edit/write/bash/ls` 的 `renderCall/renderResult`，保持 execute/schema 引用不变。
- 当前通用 `renderToolCall()` 只返回 canonical header；因此 write 参数流中的 `content` 完全没有展示。
- 当前创建结果仅在 expanded 时从 `details.ptcValue.lines` 显示最多 12 行；collapsed 只有标题。
- 当前覆盖结果已有 `DiffBodyComponent`，折叠和展开行为可以保留。
- `message-borders.ts` 给除 read 外的工具统一加 Sakura 完整框，并在运行态只让 spinner 动，横边使用静态色降低刷写量。
- `message-borders.ts` 对完成态工具做缓存；运行态不缓存，适合实时 write 行更新。
- `render-mode.ts` 已统一 color/plain/screen-reader/NO_COLOR 模式，可直接决定动画与高亮启用范围。

### Pi host contracts

- `ToolExecutionComponent.updateArgs()` 每次替换 args 后调用 `updateDisplay()`。
- 每次 renderer 调用都能获得 `context.lastComponent`、`context.invalidate()`、`toolCallId`、`argsComplete`、`executionStarted`、`isPartial`、`expanded` 和 `isError`。
- `context.invalidate()` 会调用工具行 `invalidate()` 和 TUI `requestRender()`，可由共享动画节拍安全触发行级重绘。
- call renderer 和 result renderer 是两个独立 slot，各自保留 `lastComponent`；`context.state` 可跨 slot，但本需求的最终结果可直接读取 `context.args`，无需复制大内容。
- ToolExecution 在 result 存在时仍组合 call slot 与 result slot；当前扩展在 `isPartial === false` 时返回空 call component，避免重复标题。
- Pi 文档明确建议：复用 `lastComponent`、处理 `isPartial`、默认紧凑、支持 expanded，并从 result 的 `context.args` 读取参数。

### Built-in write renderer

- Pi 0.83 内置 write 已经读取增量 `args.content` 并自动语法高亮，默认显示开头 10 行。
- 内置实现使用 `getLanguageFromPath()`、`highlightCode()` 和增量高亮缓存；前 50 行全量刷新，后续新增行单行高亮。
- 当前扩展覆盖了内置 `renderCall`，这正是 write 只剩空框的直接原因。
- 内置 write result 成功时为空组件、失败时显示错误；本扩展的 hashline/readmap result 负责 create/overwrite 差异。
- `highlightCode(code, lang)` 返回带当前主题 ANSI 的行数组；`getLanguageFromPath(path)` 返回语言标识或 undefined。

### Settings architecture

- `readFooterSettings()` 从同一个 `pi-vibrant-footer.json` 合并默认值，只接收定义中声明且类型为 boolean 的字段。
- `FooterSettings` 已包含 `toolBackground` 和 `context` 等跨组件 UI 设置，不只是 Footer 文本。
- `src/index.ts` 在加载时创建一个 settings 对象，并把同一引用传给 nano-context、Footer 和 message-borders。
- 设置命令直接修改该共享对象并持久化，因此 readmap 接收同一引用即可让后续 write 渲染读取新值，无需第二套事件总线。

## Recommended Implementation Shape

### State

```ts
type WriteAnimationState = {
  targetContent: string;
  revealedContent: string;
  path: string;
  argsComplete: boolean;
  expanded: boolean;
  active: boolean;
  invalidate?: () => void;
  highlightCache?: WriteHighlightCache;
};
```

组件实例是状态所有者；共享 scheduler 只保存活动组件集合，不保存业务内容。避免 `Map<toolCallId, ...>` 的额外生命周期和清理问题。

### Adaptive stepping

- 使用固定低频 tick（目标约 40ms，即 25 FPS），不追求 60 FPS。
- backlog 很小时推进一个 Unicode 字符/字素。
- backlog 增大时按 backlog 比例提升批量，并设置单 tick 上限，目标是持续流中保持几百毫秒以内的视觉延迟。
- `argsComplete === true`、设置关闭、非 color 模式或 renderer 转入 settled 状态时立即 reveal 到 target。
- 将“根据 current/target 计算下一位置”写成纯函数，单测覆盖而不依赖真实 timer。

### Rendering

- 调用阶段 body 由 `revealedContent` 生成；动画关闭时 revealed 直接等于当前 target。
- 先净化外部控制字符，再高亮；不得让模型内容携带 OSC/CSI。
- 折叠态不渲染整个大文件：从末尾逻辑行反向处理，直到收集到 8 个实际终端显示行。
- gutter 宽度取最终可见行号位数；首行显示行号，换行续行使用等宽空 gutter。
- 先将光标追加到当前末行，再执行 ANSI 感知换行，使边界处光标自然进入下一显示行。
- 展开态完整渲染；这是用户主动操作。
- final create/error 使用 `context.args.content`，绕过 `ptcValue.lines.raw` 中的 hashline。

## Test Strategy

- 在 `tests/readmap-renderers.test.ts` 追加纯推进策略、组件复用、尾部窗口、完整展开、状态切换和宽度测试。
- 在 `tests/footer-format.test.ts` 追加 `writeAnimation` 默认值和唯一别名断言；必要时直接覆盖 settings JSON 读取兼容。
- theme mock 继续记录 `fg()` 调用；语法高亮可验证识别路径后的 ANSI/输出差异，同时避免断言具体主题色字节。
- 用手动 tick/纯函数推进代替 `setTimeout` sleep，防止 CI 抖动。
- 保留现有 write overwrite diff 回归，防止新 create 预览吞掉 diff。

## Workspace Constraints

- 初始 `git status --short` 已显示用户已有修改：`docs/work.md`。
- 初始存在未跟踪目录：`plan/archive/2026-08-11-read-routing-review-fixes/`。
- 本计划和后续实现不得回退、覆盖或清理以上内容。

## Resources

- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/src/readmap-renderers.ts`
- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/src/message-borders.ts`
- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/src/render-mode.ts`
- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/src/footer/types.ts`
- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/src/footer/settings.ts`
- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/tests/readmap-renderers.test.ts`
- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/tests/footer-format.test.ts`
- Pi docs: `/home/jielumoon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- Pi TUI docs: `/home/jielumoon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
- Host ToolExecution: `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js`
- Host write renderer: `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/write.js`
