# Findings & Decisions

## Requirements
- 搜索 Pi TUI 与其他优秀 TUI 作为参考。
- 重点研究 read/edit/write/bash/ls 等工具调用的视觉美化。
- 结合当前项目现状给出详细、可执行的推荐。
- 最好包含可直接感知的终端效果展示。
- 本轮仅研究与建议，不擅自修改产品代码。

## Research Findings
- Fast Context 定位到当前可见组件入口：`src/footer/render.ts`、`src/readmap-renderers.ts`、`src/message-borders.ts`、`src/working.ts`、`src/thinking*.ts`、`src/sakura-editor.ts` 与 `src/vibrant-footer.ts`。
- 当前项目已经接管 footer、消息边框、工具 renderer、输入框和 Working，因此优化重点应是统一视觉语法，而不是新增更多孤立装饰。
- 当前 Footer 已做窄宽度路径降级、左右预算、分行和截断，工程底子很好；视觉上却把路径、token、cache、cost、quota、model、thinking、elapsed、Blackhole 和扩展状态平铺为同层级彩色片段，缺少“主状态/次状态/告警”的层级。
- 用户消息、工具卡片、Bash 和 Editor 都使用 Sakura 渐变完整边框；工具还叠加运行/成功/失败 rail。重复的满宽边框与渐变抢占了内容注意力，连续多次工具调用时尤其容易形成“彩色栅栏”。
- 工具外框标题固定为 `◆ NAME · RUNNING` / `✓ NAME · COMPLETE` / `× NAME · FAILED`，同时工具 renderer 正文还有工具标签、路径/命令与摘要，容易发生信息重复。
- Working 使用 80ms spinner、180ms 文案刷新和 2.8s shimmer；动效清晰，但 spinner、文字渐变、边框渐变同时存在时会让界面缺少静态视觉锚点。
- Editor 复用原生编辑逻辑且只替换外框，兼容策略正确；问题不在编辑能力，而在它与消息/工具都采用同重量边框，组件角色辨识度不足。
- Readmap 调用行已经包含 `read/edit/write/bash/ls + 路径/命令 + 参数`；结果又使用 `↳ loaded/edited/returned`，再由外层卡片写一次工具名和 COMPLETE，形成三层重复语义。
- 折叠策略整体成熟：read 默认隐藏正文、edit/write 用 diff 统计与预览、bash 短输出直显长输出截断、ls 在 ≥100 列双栏；主要短板不是信息不足，而是摘要文案和视觉权重没有按工具类型分化。
- Read 的 hashline 前缀把行号设 dim、hash 设 accent、正文为 toolOutput，精确但视觉噪声偏高；hash 是机器锚点，应低于路径、代码和变更状态，而不是每行都使用强调色。
- Thinking trail 采用无全宽卡片的树形 rail、最多 100 列正文和最近 16 行预览。这套“轻 chrome + 树结构 + 局部强调”反而是全项目最成熟的视觉方向，建议把工具调用向它靠拢。
- Sakura 五段渐变被同时用于横框、状态文字、spinner、thinking 分支；品牌色识别很强，但缺少使用配额。品牌渐变应只服务于当前焦点/活动状态，完成态应退回低饱和中性色。
- 第一轮外部检索显示，两条成熟路线都值得借鉴：编码 Agent（Crush/OpenCode/Claude Code/Pi）强调线性对话中的状态和折叠；多面板 TUI（lazygit/Yazi/K9s/btop）强调固定区域、焦点和密集数据。当前项目是线性 transcript，不应照抄多面板边框，只应借其状态语义、breadcrumb 与密度控制。
- Crush 的突出点是组件化、独立 diff 视图、适量留白与清晰状态，而不是“用了更多渐变”；OpenCode/Claude Code 更重视工具步骤在对话流中的轻量层级。
- Delta 的可迁移核心是：宽屏 side-by-side、窄屏 unified、行级 gutter、词内差异、清晰 hunk header。当前 readmap 已具备大部分能力，下一步应优化 gutter 权重与摘要排版，而非重写 diff 引擎。
- Starship/Yazi 的宽度策略与当前 Footer 相近：按优先级隐藏、路径中间截断、低优先级片段降级；差别是成熟设计会把“唯一主状态”留在固定位置，而不是让十余个片段同权争抢。
- btop/K9s 的高密度可读性来自稳定网格和严格状态色；对线性 Agent UI 的启示是只给异常/变化上色，稳定完成态不需要持续高饱和绿或渐变。
- Charm/Lip Gloss 的圆角边框只是手段，其真正优势是统一 spacing、padding、border、color token。当前项目直接在多个文件里拼 rail/frame/status，缺少跨组件的视觉 token 层。
- 定向检索找到三个官方视觉资产：Crush 主 TUI、Gemini CLI canonical screenshot、Pi tree-view。它们适合对比三种方案：侧栏工作台、卡片式工具预览、极简原生 transcript。
- Gemini CLI 官方示例使用“工具名 + 动作 + 代码预览”的单个盒子，并把 GEMINI.md/MCP 数量、sandbox/auto mode 放在底部固定状态区；它证明卡片不是不能用，而是只能给需要审阅的高价值内容（写文件/命令权限），不能每次 read 都画满框。
- Pi 官方定位本身偏极简、可扩展；因此本扩展最有竞争力的方向不是复制 Crush 的固定 sidebar，而是在不破坏 scrollback 的前提下，把 Pi 原生 transcript 做成更精致的渐进披露。
- 补充审计发现：`nano-context.ts` 在 Editor 下方绘制全宽六段背景色块（system/prompt/assistant/thinking/tools/free），同时 Footer 又显示 context 百分比/窗口。它很可能是当前屏幕里最重的固定元素：既与 Footer 语义重复，又让每次输入都被一整条高饱和色带托住。
- Nano context 的数据结构很有价值，但默认视觉应改成 18–28 列紧凑 gauge 或低饱和细轨；segment 明细放到宽屏/展开态，避免全宽背景色块成为永久主角。

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| 将工具卡片视作同一套状态数据结构 | 统一 header、metadata、body、result、status，减少每个工具各画一套造成的杂乱 |
| 建议优先兼容窄终端和无 Unicode 降级 | TUI 美观不能建立在固定宽度与特定字体上 |
| 保留 Nano context 数据，降低固定视觉重量 | 数据洞察独特，但全宽多色背景条与 Footer context 重复且抢焦点 |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| 首次追加研究记录时锚点过期 | 使用工具返回的新鲜 hashline 锚点重试成功 |
| Crush README 主图只有品牌 Logo，非 TUI 截图 | 不以该图作为界面证据，继续检索官方演示资产 |
| 追加视觉发现时 edit 要求更新鲜的锚点 | 重新读取目标范围后编辑成功 |

## Resources
- 项目源码：`src/footer/render.ts`、`src/readmap-renderers.ts`、`src/message-borders.ts`、`src/working.ts`、`src/thinking.ts`、`src/sakura-editor.ts`
- Crush 官方仓库：https://github.com/charmbracelet/crush
- OpenCode 官方仓库：https://github.com/anomalyco/opencode
- Gemini CLI 官方仓库：https://github.com/google-gemini/gemini-cli
- Pi 官方站与仓库：https://pi.dev/ 、https://github.com/earendil-works/pi
- Crush 官方 TUI 图：https://github.com/user-attachments/assets/58280caf-851b-470a-b6f7-d5c4ea8a1968
- Gemini CLI 官方截图：https://raw.githubusercontent.com/google-gemini/gemini-cli/main/docs/assets/gemini-screenshot.png
- Pi 官方 tree-view 截图：https://pi.dev/tree-view.png
- Lazygit：https://github.com/jesseduffield/lazygit
- Yazi：https://github.com/sxyazi/yazi
- btop：https://github.com/aristocratos/btop
- Lip Gloss：https://github.com/charmbracelet/lipgloss

## Visual/Browser Findings
- 当前源码无直接截图；效果展示将依据 renderer 结构绘制等宽终端草图。
- 第一轮搜索结果普遍把 Crush 描述为最“glamorous”，但其真正可见优势是分区、留白与专用 diff 视图；不能简单推导为更多彩色边框。
- 多面板产品的官方截图常在 README/GIF，后续只核验高价值官方 GitHub 来源，不采信博客的主观排名。
- OpenCode 官方截图的核心非常克制：用户消息仅用深色底块 + 单侧蓝 rail；助手正文无框；Grep/Glob/Read 工具记录均为一行灰色 inline event，不显示 COMPLETE 大标题；顶部把会话标题与 token/context/cost 固定为一条 header；输入区同样只用左 rail，最底行集中展示快捷键。整屏只有蓝色作为主 accent，工具完成态主动退灰，因此信息层级非常清楚。
- OpenCode 把连续同类调用压成相邻一行事件，例如多个 Read 只显示 `→ Read path`；这验证了当前项目应移除“调用行 + COMPLETE 外框 + 结果摘要”的重复层，而不是再加卡片装饰。
- Crush README 抓到的官方图片只是品牌封面，不是 TUI 截图，不能据此评价产品内部布局；后续需要另找官方演示资产。
- Crush 官方 TUI 图验证：主内容区几乎无框，当前消息只用一条细紫 rail；右侧 sidebar 用标题 + 极细分隔线组织 Model、Modified Files、LSP、MCP；状态项用小圆点，非活动文字大面积 dim；底部快捷键合并为一行。它的“华丽”主要集中在右上 Logo，工作区本身非常安静。
- Crush 用大块留白建立主区/侧栏层级，适合宽屏工作台；当前 Pi transcript 不宜强加永久 sidebar，但可以借鉴“状态分组 + 小圆点 + 单侧 rail + dim 完成态”。
- Gemini CLI 官方图使用一张细线矩形 WriteFile 卡片：标题同一行容纳 `✓ / 工具名 / 动作 / 文件名`，正文直接显示语法高亮代码，没有第二个 COMPLETE 标题和结果摘要；这是当前 readmap 工具卡片最直接的参考。
- Gemini 的输入框采用单一蓝边，底部 path/sandbox/mode 三段对齐；相比当前 Footer 多彩片段，它保留了稳定的左中右锚点。其启动大 Logo 很有品牌感，但只适合首屏，不适合 transcript 中重复。
- Pi 官方 tree-view 图更极端：`[bash: ...]`、`[read: ...]`、`[edit: ...]` 全部是灰色单行事件，用户/助手只靠标签色和树 rail 区分，选中项才有整行背景。该图虽是树视图而非正常 transcript，却明确展示了 Pi 的设计基因：默认安静，只把焦点状态提亮。
- 对本项目最合适的综合不是照抄某一家，而是：OpenCode 的 inline 工具事件 + Gemini 的高价值预览卡 + Crush 的状态分组 + Pi 的焦点优先，再保留 Sakura 作为活动态品牌层。

## Proposed Design

### 视觉北极星：Sakura Quiet
- 80% 中性正文/留白，15% muted chrome，5% Sakura/语义强调。
- Sakura 渐变只用于当前活动态：spinner、活动 rail、输入焦点；成功完成后立即退回 muted，仅保留一个小成功 glyph。
- 正常 transcript 不画全宽框；完整边框只给展开预览、权限确认和错误详情。
- 所有工具共享同一视觉语法：`状态 → 动词 → 目标 → 结果元数据 → 展开提示`，同一信息只出现一次。
- 用户消息、Thinking、Tool、Assistant 共用 2 列左 gutter；通过 rail 形态而非更多颜色区分角色。

### 最小数据模型
每个工具只负责把参数/结果归一成 `ToolVisual { phase, verb, target, meta, preview, expandable, severity }`；一个通用 renderer 负责布局、状态色、折叠和宽度适配。不要再让 call renderer、result renderer、外层 message border 各自重复发明标题。

### 工具策略
| Tool | 折叠态 | 展开态/预览 | 特殊规则 |
|------|--------|-------------|----------|
| read | 单行：路径、范围、行数、map/symbol、Ctrl+O | 对齐行号 gutter；hash 降为 dim，不再 accent | 成功态不画框；错误用 coral rail |
| edit | 单行 + `+N −N`；默认最多 4–6 行首个 hunk | `<120` unified，`≥120` side-by-side；保留词内差异 | no-op 用 muted，不伪装 success；错误保留首条可行动信息 |
| write | created 默认单行；overwritten 走 edit 语法 | 展开时 created 最多 12 行，overwritten 显示 diff | 标题按结果写 `Create/Overwrite`，不要笼统 `Write + COMPLETE` |
| bash | 成功无输出只一行；短输出 ≤4 行直显；长输出显示末尾 3–4 行 | Ctrl+O 全量；运行中只显示 tail | 失败明确 `exit N`，默认显示首个错误 + 末尾 6–8 行，coral rail |
| ls | 单行摘要；≤8 项可直显，更多项最多 8 项预览 | 宽屏双栏、窄屏单栏 | 目录用 `▸`，文件用 `·`；不重复 `returned/COMPLETE` |

### 其它组件
- User message：移除上下满宽渐变横框和空白 padding，改为单侧 Sakura rail + 极轻背景或纯文本。
- Assistant：保持无框，当前实现方向正确。
- Thinking：保留树结构；只给 header/◇ Sakura 色，`├─/│/╰─` 改 dim；正文用主题 `thinkingText`，避免固定 RGB 在浅色主题失去对比。
- Working：只动画 spinner 或活动 rail，`Working` 文本静止；`esc interrupt` 放统一快捷键行。短任务不追加 `Worked for 0s/1s` transcript。
- Editor：暂不重做。移除其它满框后，它自然成为唯一主要 Sakura 圆角框，焦点层级反而更强。
- Footer：改为稳定左右锚点。第一行放 path/branch/session 与 model/thinking；第二行放 compact context/traffic 与 quota/elapsed。健康状态 dim，warning/error 才升色。
- Nano context：不再全宽六色背景条；并入 Footer 为 18–28 列 compact gauge，或只保留一处 context 信息。详细 segment legend 放 `/usage`/展开态。
- Blackhole/extension/planning：正常时不占永久第三行；仅活动、冷却、接近阈值或明确启用 advanced 时显示。

### 终端草图
当前工具块：
```text
╭─ ✓ READ · COMPLETE ─────────────────────────────────────╮
┃ read src/footer/render.ts:159-252                        │
┃ ↳ loaded 94 lines • map                                 │
┃ … showing 0 of 94 lines · Ctrl+O to expand              │
╰──────────────────────────────────────────────────────────╯
```
建议折叠态：
```text
  ✓ Read  src/footer/render.ts:159–252  · 94 lines · map   Ctrl+O
```
建议 edit / bash：
```text
  ✓ Edit  src/readmap-renderers.ts  +12 −31 · refactor
    981 │- const badges = [state, ...warnings];
    981 │+ const header = buildToolHeader(view);
        │  … 8 more diff lines                              Ctrl+O

  × Bash  npm test · exit 1
  ┃ FAIL tests/readmap-renderers.test.ts
  ┃ Expected: 2   Received: 3
    … 18 more lines                                         Ctrl+O
```
建议 Footer：
```text
~/opt/…/pi-jielumoon · main · visual-pass       claude/opus-4.5 · high
ctx █████░░░ 42% · ↑12k ↓3.4k · cache 68%       7d 63% ↻2d · 14m
```
建议整屏节奏：
```text
▌  把 read/edit/bash 的调用样式统一一下

箱宝先检查现有 renderer。

  ✓ Read  src/readmap-renderers.ts · 490 lines · map       Ctrl+O
  ✓ Read  src/message-borders.ts · 487 lines               Ctrl+O

  ✦ Thought trail · 2 steps
    ├─ ◇ Compare duplicated status chrome
    ╰─ ◇ Keep one canonical tool header

  ◇ Edit  src/readmap-renderers.ts  +18 −42
    981 │- const summary = summaryLine(...)
    981 │+ const view = buildToolView(...)

  ⠹ Working · 12s
```
颜色说明：活动 `◇/⠹/rail` 才走 Sakura 渐变；`✓` 低饱和薄荷绿；`×/┃` coral；路径/模型单一 accent；其余 meta 和完成工具均 dim。

### 实施优先级
| Priority | 改动 | 收益 | 成本/风险 |
|----------|------|------|-----------|
| P0 | 去掉完成工具满宽渐变框、合并三重标题 | 最大，连续工具调用立刻安静 | 中；需协调 ToolExecution 外层与 readmap renderer |
| P0 | User message 改单 rail，保留 Editor 为唯一主框 | 大，建立角色层级 | 低到中；注意 OSC133 prompt zone |
| P0 | Sakura 只用于活动态，完成态退 muted | 大，品牌色更值钱 | 低；主要是 token/状态映射 |
| P1 | Nano context 紧凑化并与 Footer 去重 | 大，底部不再像彩色广告条 | 中；涉及两个模块的数据展示边界 |
| P1 | read/edit/write/bash/ls 应用工具特定预览策略 | 大，扫读和错误定位更好 | 中；需补折叠/宽度测试 |
| P1 | Footer 两区两行 + 宽度优先级 | 中到大 | 中；现有布局基础可复用 |
| P2 | Thinking rail 降色、Working 单动画源 | 中，减少运动噪声 | 低 |
| P2 | Thinking 保持完全不动；只处理 Working 与视觉 fixture | 用户明确保留 Thinking | 低 |
| P2 | 视觉 fixture 与 40/80/120 列截图回归 | 长期收益高 | 中；单元测试外仍需 `/reload` 目视 |

### 验证矩阵
- 宽度：40 / 60 / 80 / 100 / 120 / 160 列。
- 模式：color / plain / screen-reader；truecolor 与 16-color fallback。
- 状态：partial/running、success、no-op、warning、error、cancelled；collapsed/expanded。
- 内容：CJK 宽字符、超长路径、终端图片、ANSI/Bidi 恶意文本、空输出、大 diff、大目录。
- 目视：深色/浅色主题各一次；连续 8–12 个工具调用时检查“彩色栅栏”是否消失。

## Implementation Findings
- `message-borders.ts` 已经把 User、ToolExecution、BashExecution 三种宿主组件集中补丁化，因此 P0 不必侵入 Pi 核心：User 可直接去掉上下框/空 padding；Tool/Bash 可把 settled 状态改成轻量 rail 或直接保留 readmap 内容。
- 当前工具三重语义确实由三层共同造成：readmap `renderCall` 输出动词/目标，`renderResult` 输出 `↳ loaded/edited/returned`，`message-borders.ts` 再包 `✓ TOOL · COMPLETE`。P0 应先取消外层完成标题，再把结果摘要压缩为 meta。
- `gradient.ts` 本身是通用纯渲染工具，不是问题源；真正需要收敛的是调用点。Editor/活动态继续使用现有 Sakura helper，完成工具不再调用 frame gradient。
- P0 设计约束：color 模式使用单 rail/inline，plain 与 screen-reader 必须继续走原生/语义文本；终端图片和 result image 继续完全绕过装饰补丁。
- `tests/message-borders.test.ts` 不存在，测试名称需要从 `tests/` 实际目录确认，不能猜文件名。
- Pi `ToolExecutionComponent` 的 `renderResult` context 包含 `args/isPartial/isError`，并且 call/result 顺序加入同一容器。这允许无字符串后处理地消除重复：settled 时 `renderCall` 返回空组件，`renderResult` 使用 `context.args + result.details` 直接生成唯一完整 header；running 时只由 `renderCall` 生成活动 header。
- 目标工具可设置 `renderShell = "self"`，绕过 Pi 默认成功/错误背景 Box，但仍保留宿主的图片、折叠、缓存与生命周期。相比在 ANSI 输出上猜边框，这条数据路径更干净。
- 独立 `BashExecutionComponent` 是另一条宿主路径，内部已有尾部 20 行预览和 exit code。P0 只需在外层补丁中移除 DynamicBorder、重写单个 header；P1 再调整预览数量，无需重写执行逻辑。
- Footer 现有代码已经分成 identity/path、stats、Blackhole、extension 四层，但 model/thinking 被放在 stats 右侧，导致第一行只有路径、第二行左右争抢。P1 可在不改 snapshot 的情况下把 model/thinking 移到 identity 右侧，再把 elapsed 固定到 stats 右侧。
- Nano context 的分段估算逻辑可完全保留，只替换最终 renderer：由全宽背景块改为前景色 compact bar；Footer 同时移除重复 context 数字，避免引入跨模块 store。
- Footer 健康状态当前大量使用 success/accent/warning；P1 将 quota 健康态、成本、流量、cache 健康值统一退到 muted/dim，只有 <=50% quota、低 cache hit、Blackhole 临界或 cooldown 升色。
- P1 工具密度参数收敛为：diff 6 行、ls 8 项、bash 成功短输出 4 行/长输出末尾 4 行、split diff ≥120 列；Bash 失败折叠态保留首错和末尾 6 行。
- Pi 通用 `ToolExecutionComponent` 的 Text 渲染会把 canonical header 以 ASCII 空格补齐到整行；把渲染行直接当语义标题会导致 `visibleWidth` 误判溢出。标题预算前必须剥离尾部 padding，但保留其后的 ANSI reset。独立 `BashExecutionComponent.command` 是未填充的原始命令，不能把两条路径混为一谈。
- Phase 13 审查证明 `stripOuterChrome()` 不能用 `while` 按字符形状剥离首尾边框：Bash 的真实 `────` 输出与宿主 chrome 无法仅凭重复形状区分，连续剥离会静默丢数据；最小修复是每侧最多剥一个宿主边框并补首尾水平线回归。
- `isQuietExtensionStatus()` 以任意关键词包含判定健康态，会把 `not ready`、`completed with errors`、`idle: ... failed` 等异常静默隐藏；健康过滤必须采用完整格式白名单，而不是自然语言子串。
- Footer 删除 context 数字后，原 `context` 设置、`FooterSnapshot.context`、context icon 与 `collectContextUsage()` 形成无消费者链路；为保留用户设置契约，应让 Nano context 读取同一份可变设置状态，再删除 Footer 快照死数据。
- 用户消息框的 chrome 宽度为左侧 4 列、右侧 1 列，CJK 正文还需 2 列；因此 Sakura User 安全下限与 Editor 一样是 7 列，4–6 列应回退原生渲染。
- `ls` 参数的原生缺省路径是 `.`；统一 header 不能把缺失可选 path 当成未知目标 `…`。plain 模式 marker 为空时也不能无条件保留分隔空格。