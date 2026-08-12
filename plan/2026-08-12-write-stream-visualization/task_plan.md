# Task Plan: Write 实时逐字可视化

## Goal

让 `write` 在工具参数生成阶段真实、平滑地展示正在形成的文件内容，并在创建、覆盖、失败、折叠、展开及动画关闭等状态下保持稳定、可读、可配置的 Sakura 工具卡体验。

## Current Phase

全部完成：用户目视验收与双重代码审查整改均通过。

## Scope

### In scope

- `write` 调用阶段读取实时增长的 `args.content`，实现自适应逐字展示。
- 默认显示末尾 8 个终端显示行，运行中和完成后均支持 `Ctrl+O` 完整展开。
- 按文件扩展名自动语法高亮，只显示弱色真实行号，不显示 hashline 哈希。
- 创建成功保留最终末尾 8 行；覆盖成功切换为现有 diff；失败/中断保留末尾 8 行并明确标记失败。
- 增加默认开启的 `writeAnimation` 设置、菜单项和 `write-animation` 命令别名。
- 动画关闭时取消逐字过渡和光标，但仍实时展示末尾 8 行。
- plain、screen-reader 与 `NO_COLOR` 路径保持静态、无动画、无装饰性光标。
- 覆盖单工具、并行工具、窄宽、长行、CJK/Emoji、控制序列、设置持久化及宿主生命周期回归。

### Out of scope

- 修改 `write.execute`、参数 schema、文件写入语义或 mutation queue。
- 把逐字动画扩展到 `edit`、`read`、`bash` 或 `ls`。
- 新增第三方高亮、动画或状态管理依赖。
- 改造 Sakura 外框、Thought trail、Footer 排版或其它工具卡视觉。

## Phases

### Phase 1: 需求确认与宿主契约调查

- [x] 逐项确认动画、窗口、高亮、完成态、失败态、配置和展开行为。
- [x] 检查当前 `readmap-renderers.ts`、`message-borders.ts` 与测试结构。
- [x] 阅读 Pi 扩展/TUI 文档和宿主 `ToolExecutionComponent`、内置 `write` 实现。
- [x] 记录工作区既有修改，确认不覆盖用户文件。
- **Status:** complete

### Phase 2: 建立 Write 动画状态与共享调度

- [x] 在 `src/readmap-renderers.ts` 内定义最小的 `WriteCallComponent`/状态数据，不新增无必要模块。
- [x] 通过 `context.lastComponent` 复用每个工具行组件，以 `toolCallId`/组件实例自然隔离并行 write。
- [x] 使用单个共享低频调度器推进所有活动组件；无活动组件时自动停表。
- [x] 实现自适应追赶：小积压逐字符，大积压按批次追赶；`argsComplete`、动画关闭或非 color 模式立即补齐。
- [x] 内容回退/修正时安全重建状态，不把 UTF-16 代理对拆开。
- [x] 在完成、错误、组件失活和 session 生命周期转换时停止调度，避免陈旧 invalidate。
- **Status:** complete

### Phase 3: 实现宽度感知的代码窗口与结果状态

- [x] 为 write 单独分派 `renderCall`，其它工具继续走当前 canonical header。
- [x] 标题渲染为 `Write <路径> · N lines`，其中 N 只统计已显示内容。
- [x] 运行时在首字符前和末尾显示亮色细光标 `▏`；动画关闭或结束后不显示。
- [x] 使用 Pi 的 `getLanguageFromPath()`/`highlightCode()`；未知语言退回 `toolOutput` 纯文本。
- [x] 高亮缓存按完整内容复用；内容超过硬上限时回退纯文本，避免实现不正确的半增量词法状态。
- [x] 使用真实行号的弱色 gutter；续行悬挂缩进；不显示 hashline 哈希。
- [x] 折叠态从末尾反向收集最多 8 个终端显示行，避免长行撑高；展开态完整渲染全部已显示内容。
- [x] 创建成功从 `context.args.content` 渲染最终内容：折叠末尾 8 个显示行，展开全部。
- [x] 覆盖成功保留当前 diff 渲染，不同时重复最终内容。
- [x] 错误/中断在错误 header 与首要错误信息后保留内容预览，明确内容未成功落盘。
- [x] 空内容显示明确的 dim `empty file` 状态，避免重新出现空框。
- [x] 所有外部文本先经过现有终端控制序列净化，所有输出行严格不超过传入宽度。
- **Status:** complete

### Phase 4: 接入设置、入口与文档

- [x] 在 `FooterSettings` 和 `DEFAULT_FOOTER_SETTINGS` 增加 `writeAnimation: true`。
- [x] 在设置定义增加菜单标签 `Write 逐字动画` 与唯一别名 `write-animation`。
- [x] `src/index.ts` 将共享 settings 对象传入 `installReadmapRenderers`，保证设置修改对后续渲染实时生效。
- [x] 保持旧配置兼容：缺少字段时使用默认 true，未知字段仍忽略。
- [x] 更新 README 的工具视觉、命令和配置说明。
- [x] 在实现完成并验证后，向现有 `docs/work.md` 追加记录；保留用户当前未提交内容。
- **Status:** complete

### Phase 5: 自动化验证

- [x] 为纯动画推进策略增加确定性测试，不依赖真实时间睡眠。
- [x] 验证小积压逐字符、大积压自适应追赶、argsComplete 立即补齐和非追加更新。
- [x] 验证 color 高亮调用路径与光标；plain/screen-reader/动画关闭静态展示且无光标。
- [x] 验证折叠末尾 8 个终端显示行、运行中展开、完整展开、再次折叠。
- [x] 验证长行换行、窄宽、CJK/Emoji、空行、空文件、控制序列及宽度不溢出。
- [x] 验证创建成功保留末尾、覆盖成功切换 diff、失败保留预览。
- [x] 验证多个 write 组件状态独立且共享调度器能自动启停。
- [x] 验证设置默认值、别名、读取和保存兼容。
- [x] 运行 `npm test`、`npm run typecheck`、`npm run pack:check`、`npm audit --omit=dev`、`git diff --check`。
- **Status:** complete

### Phase 6: 真实 TUI 验收与交付

- [x] 用 Pi RPC 全量加载扩展，确认入口、命令注册与 renderer patch 无启动异常。
- [x] 在仅加载当前扩展的隔离 TUI 中确认 Sakura 界面正常启动；上游模型连续 502，未生成 write 参数帧。
- [x] 用户实际使用后确认逐字动画与整体体验没有问题。
- [x] 自动化验证设置默认值、别名及关闭后的静态末尾 8 行。
- [x] 汇总 RPC、自动化、性能与用户实际验收证据后交付。
- **Status:** complete（用户验收通过）

### Phase 7: 双重代码审查整改

- [x] 限制完整语法高亮的输入规模；超限时回退纯文本。
- [x] 折叠态对超长单行先提取宽度对齐的尾部，再执行换行。
- [x] 共享动画节拍逐组件隔离异常，故障组件不影响并行 write。
- [x] 删除 `file_path` 无生产者兼容、单调用计数函数和伪高亮测试。
- [x] 增加 200k 单行性能回归与调度异常回归。
- [x] 重跑性能探针、全量测试、类型、打包、审计与 diff 门禁。
- **Status:** complete

## Data Model And Flow

```text
args.content (宿主增量更新)
        │
        ▼
WriteCallComponent.targetContent
        │  color + setting on + args incomplete
        ├──────────────► shared scheduler ─► revealedContent ─► context.invalidate()
        │
        └─ static/args complete ───────────► revealedContent = targetContent
                                               │
                                               ▼
                              sanitize → highlight/cache → line gutter
                                               │
                         collapsed: tail 8 display rows / expanded: all
                                               │
                                               ▼
                                  message-borders Sakura frame

result
  ├─ created     → args.content final preview
  ├─ overwritten → existing diff renderer
  └─ error       → error metadata + args.content preview
```

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| 只改 renderer，不包裹 execute | 保持文件写入、并发队列、错误和结果契约完全由宿主/readmap 负责 |
| 复用 `context.lastComponent` | Pi 官方推荐的行级状态载体；天然支持同一工具行持续更新 |
| 单共享调度器 | 满足并行 write 独立动画，同时避免每张卡一个高频定时器 |
| 纯函数计算推进步长 | 单测可确定性验证，不使用脆弱的真实时间等待 |
| `argsComplete` 立即补齐 | 动画不能延迟工具执行或制造“文件还没写”的假象 |
| 末尾 8 个终端显示行 | 长行换行后仍保持卡片高度稳定 |
| 展开完整内容 | 用户主动选择完整可见性，不保留旧 12 行硬上限 |
| 最终创建内容取 `context.args.content` | 避免 `ptc.lines.raw` 的 hashline 前缀，得到精确原始文件内容 |
| 覆盖完成继续展示 diff | 覆盖场景最有价值的信息是旧内容如何变化 |
| 高亮复用 Pi API | 不引入依赖，不自研解析器，并与当前主题颜色一致 |
| 设置复用共享 settings 对象 | 与 `toolBackground`/nano-context 现有热更新模式一致，避免第二套配置系统 |

## Acceptance Criteria

1. 彩色 TUI 中，write 内容随真实 `args.content` 增长而自适应逐字出现，不是执行后的假回放。
2. 默认卡片始终最多显示末尾 8 个终端显示行；长行、CJK 和 ANSI 不导致越界或高度失控。
3. 可识别文件有语法高亮、弱色行号和运行光标；未知文件安全退回纯文本。
4. 创建成功保留末尾 8 行，覆盖成功显示 diff，失败/中断保留预览并明确标错。
5. `Ctrl+O` 在运行和完成状态都能完整展开，再次切换可恢复折叠。
6. `writeAnimation` 默认开启；关闭后无动画/光标，但末尾 8 行预览仍存在。
7. plain、screen-reader 和 `NO_COLOR` 无动画副作用；外部控制序列不能注入终端。
8. 多个并行 write 状态互不污染，调度器空闲后停止。
9. 全量自动化门禁与 Pi RPC 加载验证通过；用户实际使用并确认无问题。

## Risks And Mitigations

| Risk | Mitigation |
|------|------------|
| 高频重绘导致宽终端闪烁 | 复用现有静态运行边框策略；共享约 25 FPS 或更低节拍；只 invalidate 活动工具行 |
| 大文件每帧全量高亮/换行 | 完整高亮硬限制为 8KiB；超限回退纯文本，折叠态先按宽度提取尾部再换行 |
| 参数流不是严格追加 | 检测 `startsWith`；不满足时重建缓存并夹紧 reveal 位置 |
| 组件退出后定时器残留 | 无活动项即停表；结果/完成/失活显式注销；回调使用最新 invalidate |
| 高亮 ANSI 破坏宽度预算 | 使用 `visibleWidth`、`wrapTextWithAnsi`、`truncateToWidth`，并覆盖窄宽/CJK 测试 |
| 设置字段扩大 FooterSettings 语义 | 沿用已有 `toolBackground`、`context` 的共享 UI settings 事实，不新建重复配置文件 |
| 完整展开超大文件占屏 | 这是明确的主动 `Ctrl+O` 行为；默认仍固定 8 行，可立即折叠 |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| `tests/footer-settings.test.ts` 不存在 | 1 | 读取现有 `tests/footer-format.test.ts`，设置回归应追加到该文件 |

## Notes

- 工作区开始时已有 `docs/work.md` 修改和未跟踪 `plan/archive/2026-08-11-read-routing-review-fixes/`；实现时不得覆盖或回退。
- 计划阶段不修改业务代码，不运行实现验证。
- 实现前重新读取本文件和 `findings.md`。

## Completion Status

工程实现、用户目视验收、双重代码审查整改与全量门禁均已完成。200k 字符折叠渲染由 14,865ms 降至 5ms。