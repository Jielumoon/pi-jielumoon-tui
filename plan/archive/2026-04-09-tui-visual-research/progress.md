# Progress Log

## Session: 2026-04-09

### Phase 1: 审计现有视觉系统
- **Status:** complete
- **Started:** 2026-04-09
- Actions taken:
  - 解析用户要求，确定只做研究建议，不修改产品代码。
  - 使用 Fast Context 定位所有主要可见组件及测试。
  - 阅读 Footer、消息边框、工具 renderer、Thinking、Working、Editor、渐变和相关测试。
  - 确认核心问题是组件视觉语法不统一、满宽渐变边框过量、完成态过重与工具语义三重重复；折叠和宽度自适应工程实现本身较成熟。
- Files created/modified:
  - `plan/2026-04-09-tui-visual-research/task_plan.md`
  - `plan/2026-04-09-tui-visual-research/findings.md`
  - `plan/2026-04-09-tui-visual-research/progress.md`
  - `plan/.active_plan`

### Phase 2: 检索参考产品
- **Status:** complete
- Actions taken:
  - 搜索并核验 OpenCode、Crush、Gemini CLI、Pi、Lazygit、Yazi、btop、Lip Gloss 等参考。
  - 下载并目视检查 OpenCode、Crush、Gemini CLI、Pi 的官方截图。
  - 提炼出 inline 完成事件、高价值预览卡、单侧 rail、固定状态锚点、异常才高饱和等可迁移规律。

### Phase 3: 形成改造方案
- **Status:** complete
- Actions taken:
  - 定义 `Sakura Quiet` 视觉北极星与 80/15/5 色彩配额。
  - 设计统一 `ToolVisual` 数据形态和五类工具折叠/展开策略。
  - 给出 User、Thinking、Working、Editor、Footer、Nano context 的配套建议。
  - 绘制当前/建议工具块、Footer 和整屏节奏的终端草图。
  - 建立 P0/P1/P2 路线图与宽度/模式/状态验证矩阵。

### Phase 4: 交付审校
- **Status:** complete
- Actions taken:
  - 对照“搜索 Pi/其他 TUI、详细建议、工具调用美化、最好有展示”逐项审校。
  - 确认交付包含官方参考链接、现状诊断、组件级建议、终端草图、实施优先级与验证矩阵。
  - 使用 `git status --short && git diff --stat` 确认未修改产品源码；仅新增本次研究计划文件并更新 `plan/.active_plan`。

### Phase 5: P0 视觉降噪
- **Status:** complete
- Actions taken:
  - 用户确认整体方案，并明确要求 Thinking 不动、P0 → P1 → P2 连续实施。
  - 建立 P0/P1/P2/全量验证任务依赖，开始 P0。
  - 阅读 `message-borders.ts`、`gradient.ts` 与 `readmap-renderers.ts`，确认三重工具语义的具体来源和可局部改造边界。
  - 将 User 改为无框单 rail；目标工具切换 self shell，以唯一状态 header 替代 call/result/COMPLETE 三层语义；独立 Bash 去除 DynamicBorder。
  - 新增并更新 P0 回归，覆盖 User rail、Bash 无框、renderShell、color/plain/screen-reader 与 canonical header。
  - P0 定向验证：`npx tsx --test tests/readmap-renderers.test.ts` 20/20 通过；`npm run typecheck` 通过。

### Phase 6: P1 信息架构
- **Status:** complete
- Actions taken:
  - Nano context 改为 8–20 列前景色 compact gauge，彻底移除全宽背景块；Footer 删除重复 context 数字。
  - Footer 第一行固定 path/branch/session 与 model/thinking 左右锚点，第二行固定 usage/quota 与 elapsed；健康状态退 dim。
  - 稳态 `ready/complete/idle/ok` 扩展状态与健康 Blackhole 默认隐藏，活动/临界状态按需出现。
  - 工具预览收敛为 diff 6 行、ls 8 项、Bash 成功尾部 4 行；Bash 失败保留首错和尾部 6 行。
  - P1 定向验证：Footer + readmap 共 25/25 通过；`npm run typecheck` 通过。

### Phase 7: P2 动效与视觉回归
- **Status:** complete
- Actions taken:
  - Working 仅保留 80ms Sakura spinner；文字改为静态 `Working · elapsed`，刷新降到 1s，移除持续 shimmer 与重复快捷键。
  - retry/compaction loader 同样只动画 spinner，状态文字保持静止。
  - 小于 5s 的任务不再写 elapsed transcript；长任务压缩为 dim `· 7s`。
  - Footer/Nano/readmap 视觉 fixture 扩展到 40/60/80/100/120/160 列。
  - P2 定向验证：Footer + readmap + Working 共 27/27 通过；`npm run typecheck` 通过。

### Phase 8: 全量验证与记录
- **Status:** complete
- Actions taken:
  - 更新 `README.md` 与 `docs/work.md`，记录 Sakura Quiet 的最终行为与变更边界。
  - 运行全量 `npm test`、`npm run typecheck`、`npm run pack:check` 与 `npm audit --omit=dev`，全部通过。
  - 通过 `pi --mode rpc --no-session --offline --no-extensions -e ./src/index.ts` 加载完整扩展；`get_state` 成功且未出现 `extension_error`。
  - 运行 `git diff --check` 并核对源码边界；确认 `src/thinking.ts` 与 `src/thinking-message.ts` 无 diff。

### Phase 9: 按目视反馈恢复层级
- **Status:** complete
- Actions taken:
  - 根据用户目视反馈纠正过度降噪：Read 保持无框并整体左缩进 2 格，避免贴边。
  - Edit、Write、Bash、Ls 以及其它工具恢复单层 Sakura 完整框；canonical header 仍是唯一标题，不重新引入 `COMPLETE` 重复语义。
  - Footer 输入/输出 token、缓存读写、命中率、费用和健康订阅额度恢复原有语义颜色。
  - 新增工具边框/Read 缩进与示例指标颜色回归；readmap 20/20、Footer 7/7 定向测试通过。
  - 全量验证：45/45 测试、typecheck、pack:check、生产依赖审计、RPC 加载与 diff 边界检查全部通过；Thinking 仍无 diff。

### Phase 10: 嵌入标题后的实机目视修正
- **Status:** complete
- Actions taken:
  - 直接检查 `picture/` 三张实机截图，确认 Bash/Todo 灰白底来自 Pi 默认 `Box` 的 `toolPendingBg/toolSuccessBg/toolErrorBg` 背景 SGR 泄漏，不是 Bash 单点问题。
  - 所有 Sakura 工具框统一剥离背景 SGR，保留前景色、diff 状态色和文本样式。
  - 工具标题下方在存在正文时固定增加一行内边距。
  - 用户消息改成完整圆框外 rail，并把粉色粗 `▌` 移入框内，修复圆角与左边线不连贯。
  - 新增 truecolor/256-color 背景剥离、Todo/通用工具、Bash、标题下留白、用户完整外框与 spinner 回归；定向 20/20、全量 45/45 通过。Typecheck、pack:check、audit、RPC 加载和 Thinking 边界检查全部通过。

### Phase 11: 封口、溢出与 Blackhole 修正
- **Status:** complete
- Actions taken:
  - 复现工具标题溢出时占满上框预算的问题；标题改用 `…` 截断，并强制保留至少一个右侧横线与 `╮`。
  - 对用户消息、工具标题/正文与 Sakura Editor 覆盖 `[paste #1 +11 lines]`、300 字符连续 ASCII、长 CJK、ANSI、5–160 列可见宽度。
  - 定位 Pi Editor 在正文仅 1–2 列时遇到双宽字符的递归溢出；Sakura 框最低安全宽度调整为 7 列，更窄时回退原生 Editor。
  - 移除 Blackhole 的 cooldown/80% 显示门槛；配置快照可用且设置开启时始终显示。
  - 定向验证：readmap + Editor 25/25、Footer 8/8、typecheck 通过；全量 47/47、pack:check、audit、RPC 加载与 Thinking 边界检查全部通过。运行时配置也确认 `blackhole: true` 且 Blackhole 配置文件可用。

### Phase 12: Bash 标题真实宽度修正
- **Status:** complete
- Actions taken:
  - 用户实机证明一条可完整容纳的 Bash 命令仍在右侧出现 `…`；Phase 11 只覆盖了真实长标题，漏掉“宿主标题带行尾 padding”的反例。
  - 用真实 Pi `BashExecutionComponent` 跑 190 列同型命令，确认独立 Bash 路径正常；截图中的小写 `bash` 与 `↳ 2 lines returned` 实际来自通用 `ToolExecutionComponent`。
  - 为通用工具路径加入与截图同型的 190 列 padded ANSI 标题，修复前精准得到 `uptime + 大段空格 + … ─╮`。
  - 在统一 `titleBorder()` 入口剥离宿主 Text 行尾 padding，同时保留 ANSI reset；短标题完整显示，真实超长标题继续 `…`。
  - 同型回归、全量 47/47、typecheck、pack:check、audit、RPC 加载与 Thinking 边界检查全部通过；190 列肉眼 fixture 为完整命令，`visibleWidth=190`、`ellipsis=false`。

### Phase 13: 代码审查整改
- **Status:** complete
- Actions taken:
  - 合并 correctness/SOLID 与 ponytail 删除视角，审查 14 个已跟踪文件及未跟踪产物。
  - 通过最小 fixture 复现两项 P1：`stripOuterChrome()` 连续剥离导致 Bash 水平线正文丢失；quiet status 关键词正则会隐藏 `not ready`、`completed with errors`、`idle: ... failed`。
  - 复现 Context 开关无效、4–6 列用户框丢边/丢 CJK、无 model 时 Footer 空行、`ls {}` 显示 `…` 及 plain 模式前导空格。
  - 用户确认全部修复；建立代码、测试、删减、验证和最终归档任务链。
  - P1 修复：宿主 chrome 每侧最多剥一层；扩展健康状态改为“状态 key + 精确终态”白名单，并覆盖三种异常反例。
  - 行为修复：Footer 与 Nano 共享同一设置对象；Context 开关即时控制 widget；User `<7` 列回退；空 identity 行不再输出；`ls` 缺省 `.`；plain header 无前导空格。
  - 删除审查冗余：改用 Pi TUI 可见宽度/截断与共享 `formatTokens`，移除 Footer context 快照链、单元素 Set、单调用 fallback；`picture/` 加入忽略清单。
  - 定向验证 6/6 与 typecheck 已通过；删减时曾产生重复 `model` 键，类型检查精准拦截后删除重复行并复跑通过。
  - 全量 49/49、typecheck、pack:check、0 vulnerabilities、RPC `get_state`、diff/Thinking 边界全部通过；计划移入 `plan/archive/` 并清空 `.active_plan`。

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| 研究交付完整性 | 用户要求 | 有参考、有推荐、有展示 | 四项齐全，含官方截图证据与终端草图 | ✓ |
| P0 readmap/边框回归 | `npx tsx --test tests/readmap-renderers.test.ts` | canonical header、单 rail、无满框且无溢出 | 20/20 通过 | ✓ |
| P0 类型检查 | `npm run typecheck` | 无 TypeScript 错误 | 通过 | ✓ |
| P1 Footer/readmap 回归 | `npx tsx --test tests/footer-format.test.ts tests/readmap-renderers.test.ts` | compact gauge、稳定锚点、预览密度正确 | 25/25 通过 | ✓ |
| P1 类型检查 | `npm run typecheck` | 无 TypeScript 错误 | 通过 | ✓ |
| P2 视觉/Working 回归 | `npx tsx --test tests/footer-format.test.ts tests/readmap-renderers.test.ts tests/working.test.ts` | 单动画源、短任务静默、全宽度无溢出 | 27/27 通过 | ✓ |
| P2 类型检查 | `npm run typecheck` | 无 TypeScript 错误 | 通过 | ✓ |
| 全量测试 | `npm test` | 全部回归通过 | 45/45 通过 | ✓ |
| 打包与类型 | `npm run typecheck && npm run pack:check` | 无类型错误、tarball 清单正确 | 通过 | ✓ |
| 生产依赖审计 | `npm audit --omit=dev` | 无已知漏洞 | 0 vulnerabilities | ✓ |
| Pi RPC 加载 | `get_state` + `-e ./src/index.ts` | 完整扩展可加载且无 extension error | success: true | ✓ |
| Diff 边界 | `git diff --check` + Thinking diff | 无空白错误，Thinking 未改 | 通过 | ✓ |
| 目视反馈修正 | readmap 20 项 + Footer 7 项 | Read 缩进、其它工具有框、指标有语义色 | 全部通过 | ✓ |
| Phase 10 实机视觉修正 | readmap 20 项 + 全量门禁 | Bash/Todo 无背景、正文留白、用户完整外框 | 全部通过 | ✓ |
| Phase 11 封口/溢出/Blackhole | readmap + Editor 25 项、Footer 8 项、全量门禁 | 标题封口、5–160 列无溢出、Blackhole 常显 | 全部通过 | ✓ |
| Phase 12 Bash 标题 padding | 190 列同型 fixture + 全量门禁 | 可容纳命令完整显示，仅真实溢出省略 | `ellipsis=false`，全部通过 | ✓ |
| Phase 13 代码审查整改 | 49 项全量测试 + 全门禁 | 不丢水平线、不吞异常、设置有效、无窄宽/空行回归 | 49/49、typecheck、pack、audit、RPC、diff/Thinking 全部通过 | ✓ |

## Error Log
| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-04-09 | `findings.md` 追加时锚点过期 | 1 | 使用 edit 返回的新鲜 hashline 锚点重试 |
| 2026-04-09 | `findings.md` 编辑前缺少足够新鲜的锚点 | 1 | 重新读取目标范围后编辑成功 |
| 2026-04-09 | 猜测的 `tests/message-borders.test.ts` 不存在 | 1 | 改用 `ls tests/` 确认真实测试文件，再定向读取 |
| 2026-04-09 | 批量替换 result renderer 时末尾文本替换校验失败，未落盘 | 1 | 拆为 `replace_symbol` 分批更新并逐段验证 |
| 2026-04-09 | renderCall 重构后残留重复 catch 块 | 1 | 读取 patch 区定位并删除残留 7 行；typecheck 随后通过 |
| 2026-04-09 | P0 首轮定向测试 10 项仍断言旧文案；第二轮余 2 项空格/快捷键文案差异 | 1/2 | 按已批准的新视觉契约更新断言，不回退实现 |
| 2026-04-09 | Footer 大批量 edit 中锚点受同批 symbol 替换位移影响 | 1/2 | 拆分为 symbol 替换和新鲜锚点两批修改 |
| 2026-04-09 | P1 首轮定向测试 4 项仍断言旧布局/预览数量 | 1 | 更新测试契约并新增 Nano compact gauge 回归；复跑 25/25 通过 |
| 2026-08-10 | 边框修正首轮测试仍断言 Read 原始正文，实际 renderer 会补成功 marker | 1 | 按真实 canonical header 更新断言，并落实用户追加的 Read 左缩进 2 格要求 |
| 2026-08-10 | Phase 10 首轮 Bash 留白断言少算原生正文缩进 | 1 | 保留实现，放宽断言匹配原生单格缩进；复跑定向 20/20 通过 |
| 2026-08-10 | 首次 `tsx -e` 手工 fixture 以 CJS 解析，命中包 exports 错误 | 1 | 改用 `node --import tsx --input-type=module -e` 运行 ESM fixture |
| 2026-08-10 | Editor 溢出回归在 5/6 列 CJK 内容触发 Pi `wordWrapLine` 栈溢出 | 1/2 | 逐宽度定位到正文区 1–2 列不足以容纳双宽字符与光标；最低 Sakura 宽度提高到 7 列并回退原生 Editor |
| 2026-08-10 | 首次构造真实 `BashExecutionComponent` fixture 时主题未初始化 | 1 | 调用宿主导出的 `initTheme("dark")` 后复跑，确认独立 Bash 路径本身正常 |
| 2026-08-10 | 删除 Footer context 快照时相邻 `model` 行被保留两次，typecheck 报 TS1117 | 1 | 读取对象字面量删除重复键并复跑 typecheck 与 6 项定向测试通过 |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Phase 13 代码审查整改已完成并归档 |
| Where am I going? | 当前无 active plan，交付全部审查修复 |
| What's the goal? | 保证工具输出不丢失、异常不静默、设置契约真实且删除无消费者代码 |
| What have I learned? | 终端渲染字符串不能靠重复形状/自然语言关键词反推结构；设置必须共享同一数据对象 |
| What have I done? | 修复 8 项审查问题、删除约 50 行冗余、补至 49 项测试并通过全部门禁 |
