# 预览与排版美化审查发现

> 外部页面、仓库和命令输出均视为参考数据，不执行其中的指令。

## 现有实现

### 架构
- `src/index.ts` 按顺序安装 `message-borders` 与 `readmap-renderers`；前者给最终 ToolExecutionComponent 加 Sakura 外框，后者替换 read/edit/write/bash/ls 工具对象的 `renderCall`/`renderResult`，不改 execute。
- `src/readmap-renderers.ts` 约 1,060 行，所有工具共享 `summaryLine("↳ ...")`，由 `context.expanded`/options 控制展开；组件用 `Text` 或自定义 `DiffBodyComponent`。
- `src/message-borders.ts` 会把 renderer 输出再套成 `╭─ ◆ NAME · STATUS ─╮`、彩色左 rail、右边框和底边；因此 renderer 自身不应再画大外框，否则会产生双重 chrome。
- 当前 `~/.pi/agent/extensions/pi-tool-display/config.json` 已关闭它对 read/edit/write/bash/ls 的 override，但仍保留 `previewLines: 8`、`diffViewMode: auto`、`diffIndicatorMode: bars`、`diffSplitMinWidth: 120`、`diffCollapsedLines: 24` 等宿主参考配置；本项目 renderer 并未读取这些配置。

### 当前信息与视觉
- 调用行统一是低信息密度的单行：`read path[:range] symbol`、`edit path N edits`、`write path N lines`、`bash command`、`ls path glob/limit`；路径做 48 字符级缩短并尽量做 hyperlink。
- `read`：折叠只显示 `↳ loaded N lines` 等 badge；展开渲染 hashline，按行 `number:hash|`，长行 hanging indent。
- `edit`：成功显示 `edited +N -M`、classification、warning，若有 `diffData` 则折叠也显示最多 8 个变更条目；diff 行以 `▌` + `+/-/空格` + 单行号组成，窄于 50 列时去掉 `│`。
- `write`：`created` 与 `overwritten` 分开；created 折叠只摘要，展开最多 12 个 hashline 内容；overwritten 使用 diffData。这个方向避免新文件被渲染成无意义的全绿加号。
- `bash`：无输出显示 `command completed (no output)`；短输出（≤12 行且 ≤2,000 字符）折叠也全文展示；长输出折叠展示前 12 行并给 more/`Ctrl+O` 提示，错误默认首行、展开全文。
- `ls`：条目用 `▸ name/` 或 `· name`，折叠最多 12 项，统计 total/truncated，展开全部。
- 结果文本会净化 OSC/CSI/控制字符，tab 转空格；用 `visibleWidth`、`truncateToWidth`、`wrapTextWithAnsi` 做宽度约束。已有 40/80/100/120 列不溢出测试，以及控制序列、主题异常 fallback 测试。
- `message-borders.ts` 的 tool label 是 `◆ NAME · RUNNING` / `✓ NAME · COMPLETE` / `× NAME · FAILED`，状态通过顶部标题、左侧 rail 和颜色表达。readmap 里的 `↳` 语义与外层框目前没有层级/颜色区分。

### 直接渲染样例（当前实现，去掉颜色与外层框）

```text
read 折叠：
↳ loaded 2 lines • map • Ctrl+O to expand

read 展开：
↳ loaded 2 lines • map
20:a1f|const value = 1;
21:b32|return value;

edit 折叠（当前会出现两条摘要）：
↳ edited +2 -1 • Ctrl+O to expand
↳ diff +2 -1
▌- 10 │ const old = true;
▌+ 10 │ const next = true;
▌+ 11 │ return next;

write 新建展开：
↳ created • 3 lines
1:abc|export const answer = 42;
2:def|
3:ghi|

bash 短输出：
↳ 3 lines returned
✓ build passed
Tests: 35 passed
Time: 2.1s

ls 展开：
↳ 4 entries returned
▸ src/
· README.md
· 组件.ts
· very-long-file-name-that-needs-truncation.ts
```

### 已确认的视觉/语义问题
- **摘要重复**：edit/overwritten write 先输出 `edited/overwritten` 摘要，又让 `DiffBodyComponent` 输出第二个 `↳ diff` 摘要；外层还有 `◆ EDIT · COMPLETE`，同一状态被表达三次，内容反而没有真正的文件/hunk 信息。
- **gutter 不稳定**：diff 行号不按最大行号补齐，`1`、`20`、`100` 会导致内容列跳动；read 的 `number:hash|` 也未把行号、hash、正文分成不同视觉层。
- **diff 只着整行色**：当前 `tintEntry` 对整条前缀+内容染色，没有利用结构化 `inlineDiffs`。删除/新增长句只有红/绿整行，审阅者很难快速定位真正变化的 token；暗色主题还可能出现背景/前景对比度问题。
- **diff 统计口径含糊**：`totalRenderable`/`hidden` 按 entry 数计，但一条 entry wrap 成多行时提示仍写 `more diff lines`；context 在窄屏被跳过后，提示也不说明是 compact 模式。
- **布局模式单一**：本地 `DiffData` 只声明 entries/stats，未保留 readmap 已生成的 `language`、`blockRanges`、`inlineDiffs`；本地 renderer 固定 unified，没有利用 100+ 列的 split，也没有 hunk 标题。
- **长内容提示不一致**：bash/ls/write 使用 first-N，readmap 原生 helper 的 collapsed preview 采用 tail-N；各工具均有 `more` 文案但没有统一“已显示/总数/隐藏原因”语法。
- **代码正文缺少语法层**：read/write hashline 只把整行当 `toolOutput`，没有把 hash gutter、正文、空白/不可见字符分开；这不是必须马上引入高亮库，但至少应该有稳定 gutter 和可选 whitespace 标记。
- **Bash 像普通文本**：输出没有 `│`/缩进/代码块层级，第一行摘要和 stdout 视觉上粘在一起；失败只显示首行，缺少 exit code/duration 等结构化状态（若 details 有则应呈现）。
- **ls 是单列堆叠**：已有类型符号，但没有类型/名称列对齐、目录分组、宽屏 grid/tree、文件名中 CJK/emoji 的列宽验证；超长名称当前只依赖最终裁剪，缺少明确的省略语义。
- **路径宽度计算有隐患**：`shortenPath` 用 `path.length` 与 `candidate.length` 判断预算，不是 `visibleWidth`；CJK、emoji、组合字符路径可能在 hyperlink/外框中错位。
- **空白信息被静默压平**：tab 被替换为单空格，控制字符被删除；安全上正确，但审阅代码/日志时无法知道原本有 tab 或不可见字符。应提供可选 `showWhitespace`/diagnostic 标记，不默认污染。
- **可访问/无色降级尚未成型**：当前结构大体能去色，但 `↳`、`▌`、`▸`、`·`、box/rail 语义未定义；没有 plain/screen-reader 模式，也没有快照基线。
- **实现重复且会漂移**：本地 `readmap-renderers.ts` 复制了 readmap 私有 `tui-render-utils.ts`/`tui-diff-renderer.ts` 的 summary、宽度、hanging indent 和 diff 模式逻辑，但又删减了 native 的 split/compact/inline/hunk 能力；readmap 升级后容易出现行为分叉。

### 当前测试覆盖
- `tests/readmap-renderers.test.ts` 覆盖 patch 幂等与注册拦截、read 展开/错误、edit diff/no-op/error、write created/overwritten、bash 短长输出/错误、控制序列净化、ls 条目/截断/空目录/错误、宽度和主题异常。
- 现有测试主要断言“包含/不包含某文本”和“不溢出”，没有截图/快照式视觉基线，也没有测试 Unicode 东亚宽字符、组合字符、emoji、tab 展开后的对齐、ANSI 样式嵌套、超窄宽度下的语义降级。
- `npm test` 当前 35/35 通过；`npm run typecheck` 当前通过。`git status` 显示仓库原有 `AGENTS.md` 有未提交修改，本轮没有碰它；本轮新增的三个 `plan/` 文件是审查工作记录。

## 外部参考

### bat（sharkdp/bat）
- 把“代码正文”和“装饰层”拆开：header-filename/filesize、grid、numbers、changes、snip 都是可独立组合的 style component；交互终端默认装饰，管道可关闭，支持 `NO_COLOR`/plain 思路。
- 对文件预览提供语法高亮、行号、变更 gutter、文件头、行截断/换行选项；这说明 `read` 更适合引入轻量文件头和稳定 gutter，而不是只显示 badge。
- 非打印字符可显式显示，tab 有可控宽度；但默认不把控制字符原样送进终端。我们的净化策略是正确基础，下一步应把“空白/不可见字符”做成可选标记，不要静默丢失诊断信息。
- 官方 README：<https://github.com/sharkdp/bat/blob/master/README.md>。

### git-delta（dandavison/delta）
- diff 的核心不是大面积颜色，而是稳定的左右行号 gutter、`+/-` 语义、hunk/file header 层级、可选 side-by-side、word-level change highlight 和宽度感知换行。
- 支持 header/line/box 装饰、超链接、复制友好模式和 dark/light theme；可借鉴“结构层可配置”，但当前扩展应先做 unified diff 的对齐与 hunk 信息，别立刻引入完整 side-by-side。
- delta 的启发是：删除/新增不要只给整行一种颜色；把行号、变更标记、内容、hunk 间隔分别着色，信息在无色模式仍成立。
- 官方项目：<https://github.com/dandavison/delta>。

### ripgrep（BurntSushi/ripgrep）
- `--heading` 把文件名提升为分组标题，下面缩进展示行号/列号/匹配内容；这比每行重复完整路径更适合大量输出。
- `--max-columns` + `--max-columns-preview` 明确区分“限制输出”和“告诉用户原行被裁掉”；这是当前 bash/read 长行截断提示可以借鉴的语义。
- 颜色可分别配置 path、line、column、match，但有 `--color=never` 和 JSON 输出；启发是保留无色可读结构，并把机器数据与漂亮输出分开。
- 官方项目：<https://github.com/BurntSushi/ripgrep>，用户指南：<https://github.com/BurntSushi/ripgrep/blob/master/GUIDE.md>。

### eza（eza-community/eza）
- `ls` 不只是逐行列表：grid/long/tree 是信息密度的三种布局；long 有稳定字段列，tree 用缩进和连接线表达层级。
- 图标、颜色、Git 两字符状态、hyperlink 都是可独立关闭的增强层；`--width`/`COLUMNS` 参与布局。对本项目而言，先做“类型列 + 名称列 + 截断/统计”，图标只能作为可选层。
- 关键不是把名字染色，而是让目录层级、文件类型、数量和截断状态可快速扫描；无色模式仍要保留 `/`、`▸`、状态字符等结构。
- 参考手册：<https://man.archlinux.org/man/eza.1.en.txt>。

### AI coding CLI
- Aider 的官方源码/文档显示：pretty 输出与纯文本输出分离，使用 Rich Markdown/代码主题/角色颜色；`NO_COLOR` 或 dumb terminal 会关闭 fancy 输出。这验证了“漂亮层可降级，语义不可丢”的方向。
- Claude Code 官方 accessibility 文档提供 `--ax-screen-reader`：去除 box-drawing、颜色依赖、动画和原地重绘，改成带 `you:`/`claude:`/`tool:`/`tool error:` 等标签的线性 scrollback。即便当前不做无障碍模式，也应让我们的预览在去掉边框/颜色后仍可读。
- Codex CLI 的公开 issue 暴露了 diff 对比度问题：红/绿背景叠加语法色和 DIM 可能不可读。结论很实用：diff 行背景与 token 前景不能无脑叠加，暗色主题下要优先保证 gutter/sign/content 的对比度，并提供纯色/无色降级。
- Claude accessibility：<https://code.claude.com/docs/en/accessibility>；Aider 源码：<https://github.com/Aider-AI/aider/blob/main/aider/io.py>；Codex issue 例：<https://github.com/openai/codex/issues/33440>。

## 设计结论
- 首先优化信息层级、gutter 对齐和可扫描性，不先堆更多颜色/边框。
- renderer 只负责内容结构，外框与状态交给 `message-borders.ts`，避免重复 chrome。
- 参考 bat 的可组合装饰和 delta 的 diff gutter：下一版应该把“标题/路径、摘要/状态、内容 gutter、折叠提示”做成明确四层；颜色只是第二编码，不能承担全部语义。
- 参考 rg/eza：长内容要说明“显示了多少、还隐藏多少、为什么隐藏”；目录结果优先分组/对齐，而不是把条目简单堆成一列。
- 参考 Aider/Claude：视觉层必须可拆除，建议为 renderer 预留 plain/accessible 的结构语义，不让 box、颜色、spinner 变成信息来源。

## 建议的视觉方案

### 1. 统一四层语法

保留现有 `message-borders.ts` 的外框，renderer 内部只输出四层：

1. **summary**：一次性说清工具、路径/命令、状态、统计、是否隐藏。
2. **gutter**：行号、hash、`+/-`、类型符号等结构信息，固定宽度。
3. **body**：代码正文、stdout、文件名；默认不画第二层大边框。
4. **hint**：只在确实隐藏内容时显示一次 `… showing X of Y · Ctrl+O`。

建议去掉结果中的重复 `↳ diff ...`；外框已经表达 `✓/×/◆ TOOL · STATUS`，结果只保留一个 summary。颜色只做第二编码，`+/-`、`✓/×`、`/`、`▸` 和明确文字保证无色可读。

### 2. 80 列主视觉稿

以下是 wireframe，不是当前截图；`┃`/`│` 表示外框与内容层级，真实实现继续由 `message-borders.ts` 负责外框：

```text
╭─ ✓ EDIT · COMPLETE ───────────────────────────────────────────╮
┃  src/foo.ts  edited +2 -1 · 1 hunk                          │
┃  10  - │ const old = true;                                  │
┃  10  + │ const next = true;                                 │
┃  11  + │ return next;                                        │
╰───────────────────────────────────────────────────────────────╯

╭─ ✓ READ · COMPLETE ───────────────────────────────────────────╮
┃  src/foo.ts:20–21 · loaded 2 lines · map                    │
┃  20  a1f │ const value = 1;                                 │
┃  21  b32 │ return value;                                    │
╰───────────────────────────────────────────────────────────────╯

╭─ ✓ BASH · COMPLETE ───────────────────────────────────────────╮
┃  $ pnpm test · output 3 lines                               │
┃  │ ✓ build passed                                           │
┃  │ Tests: 35 passed                                          │
┃  │ Time: 2.1s                                               │
╰───────────────────────────────────────────────────────────────╯
```

40 列时不要硬塞 metadata，降级为：

```text
╭─ ✓ EDIT · COMPLETE ─────────────╮
┃  edit +2 -1 · 3 lines hidden   │
┃  10 - const old = true         │
┃  10 + const next = true        │
╰─────────────────────────────────╯
```

### 3. 各工具建议

- **read**：结果 summary 补回 `path:range`（便于滚屏后定位），正文拆成 `line number`、`3-char hash`、`│`、content 四段；行号按当前块最大值补齐。长行继续 hanging indent；折叠提示统一为 `showing X of Y lines · Ctrl+O`。不要默认上语法高亮依赖，先做 gutter 层。
- **edit**：summary 只留 `path · edited +N -M · classification/warnings`；diff 先做稳定 unified。`blockRanges` 作为淡色 hunk 分隔/标题，`inlineDiffs` 作为 token 级强调；不要再对整条 diff 强行上大面积背景色，暗色主题优先对比度。宽度 ≥100/120 且 old side 存在时可做 split，<50 只显示 `+/-` 变化行。
- **write**：created 继续用“文件内容预览”，不伪装成全绿 diff；overwritten 复用 edit 的同一 diff body。created summary 明确 `created · N lines`，内容同 read 的 hash gutter；空文件显示 `created · empty` 而不是空白卡片。
- **bash**：调用行用 `$ command`；结果用 `output X lines`，stdout 每行统一 `│ ` 缩进，隐藏提示放在末尾。只有 `details` 确实提供 exit code/duration 时才展示 `exit 1 · 2.1s`，不要猜。短输出保留当前“不过度压缩”偏好。
- **ls**：窄屏维持单列但固定类型符号；≥80 列在 `visibleWidth` 下尝试两列/网格，放不下自动退回单列。目录保持 `/`，文件名可 hyperlink；没有子项数据不要伪造 tree。长名字用显式 `…` 并在 summary/hint 说明被裁剪。

### 4. 字符与终端策略

- 所有预算统一走 `visibleWidth`；`shortenPath` 的预算不能再用 `string.length`。对 CJK、emoji、组合字符、ANSI 样式分别测试。
- 增加 Unicode 双向控制字符（U+202A–U+202E、U+2066–U+2069）净化；零宽字符不要盲删，诊断模式可显示可见占位符，默认保持源码语义。
- tab 默认按 4 列制表位展开（或至少使用统一策略），诊断模式用 `→`/`·` 标记；不要把 tab 静默变成一个空格后再假装对齐。
- 继续先净化外部文本再着色；`NO_COLOR`/plain 模式下保留所有结构符号和文字状态。将 OSC/CSI 安全净化测试扩展到 bidi/tab/组合字符。

### 5. 建议优先级

**P0，先做就明显变好**
- 消灭 edit/overwritten 的重复 summary。
- 行号/hash/类型列按 `visibleWidth` 对齐。
- 统一 `showing X of Y · Ctrl+O` 提示和 `first-N`/`tail-N` 策略。
- 修正路径 CJK/emoji 宽度。

**P1，完成一轮真正的美化**
- read/write hash gutter 分色分段。
- Bash stdout 子层级与 `output` summary。
- ls 宽屏双列与目录/文件类型扫描。
- 暗色主题 diff 对比度和无色模式回归。

**P2，再做高级能力**
- `blockRanges` hunk 标题、`inlineDiffs` token diff、≥100 列 split view。
- 可选 whitespace/bidi 诊断显示。
- plain/screen-reader 线性输出开关。
- 不引入新的 diff 算法，不急着把语法高亮库塞进扩展。

### 6. 实施与验证路线

- 先把 `readmap-renderers.ts` 内的宽度、summary、hashline、diff 行格式拆成少量本地纯函数；不要搭通用 renderer 框架。
- 扩展本地 `DiffData` 的可选字段以 feature-detect readmap 已有 `language`/`blockRanges`/`inlineDiffs`，不 import readmap 私有模块，也不改 execute。
- 测试增加 40/80/120 列纯文本快照（剥离 ANSI）、CJK/emoji/组合字符路径和名称、混合 1/20/100 行号、长行换行、bidi/tab/OSC 净化、重复 summary 断言。
- 最后用真实 Pi TUI `/reload` 检查 40/80/120 列、暗/亮主题、Ctrl+O、成功/失败/partial、外框只出现一层；单元测试通过不能代替目视确认。


## P1/P2 实施设计（2026-08-07）
- Pi 原生 `DiffData` 已确认可选字段为 `language`、`blockRanges`、`inlineDiffs`；`InlineDiff` 以 entries 数组索引配对，span kind 为 `equal/add/remove`。本地 renderer 只扩展兼容类型，不导入 readmap 私有模块，也不复制 diff 算法。
- P1 hashline 采用三段着色：行号/冒号使用 `dim`，hash 使用 `muted`，正文使用 `toolOutput`；ANSI 只由 theme 生成，plain/mock theme 仍保留完整 gutter 语义。
- P1 Bash 结果增加 `│ ` stdout 子层级；仅在 details 提供 `exitCode`、`durationMs`/`duration` 时展示 metadata，不猜测缺失状态；折叠提示仍是唯一 hint。
- P1 ls 在宽度足够时使用两列网格，列宽按 `visibleWidth` 计算并对 CJK/emoji 超长名称做显式 `…` 裁剪；窄屏和无法安全分栏时退回单列。
- P2 diff 采用 feature-detect：hunk 用 `blockRanges` 生成轻量 `┄` 标题；inlineDiffs 只着色 add/remove span，缺字段时保留整行颜色；宽度 ≥100 且存在旧侧启用 split，<50 只显示 add/remove，<24 降级为摘要。
- P2 whitespace/bidi/plain 通过可选 renderer context flags 实现，默认行为不变：tab 用 `→`/`·` 诊断，双向控制字符显示 `‹bidi›` 诊断；plain/screen-reader 去除颜色与装饰性 box，但保留 `tool:`/`output:`/`diff:` 标签和 +/- 语义，不改 execute/schema。
- 为防止过度设计，先在单文件内添加少量纯格式化函数；所有输出继续交给 `message-borders.ts` 外框，不新增依赖。


## 2026-08-07 审查整改发现
- Pi 0.83 `ToolRenderContext` 只有 args/toolCallId/invalidate/lastComponent/state/cwd/executionStarted/argsComplete/isPartial/expanded/showImages/isError，`ToolRenderResultOptions` 只有 expanded/isPartial；没有 width/renderMode/diagnostics。宽度敏感布局必须延迟到 `Component.render(width)`。
- Pi 0.83 `BashToolDetails` 只有 truncation/fullOutputPath；此前 exitCode/duration 测试使用了生产者不会提供的字段，应删除，不能把测试 fixture 当契约。
- split 不能按相邻 remove/add 配对；上游 inlineDiffs 用 entries 索引表达配对，多行 replacement 通常是 remove 块后接 add 块。
- 两列 ls 的渲染行数不等于条目数；必须先决定可见条目，再布局并用条目数生成 hint。
- `Math.max(...array.map())` 对大 diff/hashline 会触发参数栈溢出；改用 reduce，折叠态只按可见数据计算宽度。
- plain/screen-reader 只有 readmap 内层模式不够；`message-borders` 若继续输出 Sakura 真彩外框，就不是线性/无色输出。
