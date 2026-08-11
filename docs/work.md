# 工作记录

2026-08-03 04:32---需要建立独立 Pi 扩展包---创建 `pi-jielumoon-tui` 包骨架并完成初版 TUI---新增包配置与初版 `src/` 模块；后续因需求边界修订，初版自定义 editor、Working 和工具 rail 已删除。

2026-08-03 04:59---初版功能偏离“完整拥有 pi-vibrant-footer、只增加思维链”的要求---以 `pi-vibrant-footer` 当前模块为基线迁移 Footer、nano-context、usage、Blackhole，并只保留 sakura Thought trail---修改 `package.json`、`src/vibrant-footer.ts`、`src/nano-context.ts`、`src/footer/*`、`src/thinking.ts`、`src/thinking-message.ts`、`src/gradient.ts`、`src/prototype-patch-registry.ts`、`README.md`。

2026-08-03 05:26---nano-context 重构版把原版背景色块改成前景字符，彩条与原图不一致---从 `pi-vibrant-footer` Git 原始版本恢复固定 RGB 背景色、深色标签与 free 区空格填充，同时保留重构后的生命周期清理---修改 `src/nano-context.ts`；通过类型检查、打包检查、依赖审计和 TUI ANSI 背景色验证。

2026-08-03 05:40---用户要求简化 Thought trail 和重命名命令---移除每条思考内容开头的 `Thinking:` 前缀；将无参数配置命令改为 `/jielumoon-tui` 并直接打开设置面板---修改 `src/thinking-message.ts`、`src/footer/settings.ts`、`README.md`；已初始化 Git 仓库并使用 main 分支，最终 commit 已完成。

2026-08-03 06:10---用户纠正消息边框应只用于用户消息和工具调用，并反馈用户边框视觉不佳---移除助手回复/Thought trail 的边框，复用 Sakura 用户消息的粗 `▐` rail 与完整 macaron Markdown 主题，为 ToolExecution/BashExecution 增加 Sakura 工具卡片边框---修改 `package.json`、`src/message-borders.ts`、`src/prototype-patch-registry.ts`、`plan/task_plan.md`、`plan/progress.md`；类型检查、打包检查、依赖审计、RPC 加载和重新安装均通过。

2026-08-03 06:20---用户要求 `9/9 phases complete` 可在设置中开关---在 `FooterSettings` 增加 `planning` 字段，过滤 `planning-with-files` 状态并接入设置面板与命令---修改 `src/footer/types.ts`、`src/footer/render.ts`、`README.md`、`plan/task_plan.md`、`plan/progress.md`；类型检查、打包检查、依赖审计、RPC 加载和重新安装均通过。

2026-08-03 06:30---消息增多后 TUI 出现卡顿---消息边框扩展每次重绘都重复计算历史用户 Markdown 与已完成工具边框---修改 `src/message-borders.ts`，增加用户消息/已完成工具缓存和 invalidate 清理；流式工具保持实时渲染；类型检查、打包检查、依赖审计、RPC 加载和重新安装均通过。

2026-08-03 06:45---用户要求主动排查潜在优化，避免问题由用户发现---审计 Thought trail、Bash/工具边框、隐藏思考标签、nano-context token 估算和 patch 生命周期---修改 `src/thinking-message.ts`、`src/message-borders.ts`、`src/nano-context.ts`、`src/thinking.ts`、`src/prototype-patch-registry.ts`；增加完成态缓存、热路径快速判断、上下文历史消息缓存和 shutdown 清理；所有验证通过。

2026-08-03 07:20---用户反馈 Footer 延迟更新---确认原版 30 秒定时器未改变，真正瓶颈是普通事件中同步全量扫描 usage 和 Blackhole，阻塞 TUI 重绘---修改 `src/vibrant-footer.ts`，按事件拆分轻量与重型 snapshot 刷新，保留立即 `requestRender`；类型检查、打包检查、依赖审计、RPC 加载和重新安装均通过。

2026-08-03 08:00---代码审查后用户明确要求 Blackhole 指标保持实时、不缓存，并修复其余性能与可靠性问题---Blackhole 每次基于当前 branch 重算但单次只估算每个 source 一次；usage 改为 append-only 增量累计；nano-context 复用事件 messages；工具缓存使用 updateDisplay revision 失效；恢复渲染边界校验---修改 `src/footer/blackhole.ts`、`src/footer/usage.ts`、`src/vibrant-footer.ts`、`src/nano-context.ts`、`src/message-borders.ts`、`src/prototype-patch-registry.ts`、`src/thinking-message.ts`；类型检查、打包检查、依赖审计、RPC 加载、四项定向行为验证和重新安装均通过。

2026-08-03 08:20---用户纠正工作状态视觉：彩虹色板应与 Thought trail 的 macaron 一致，`⠦` 只是原生转圈动画的一帧---将 `src/working.ts` 改为复用 `renderSakuraGradient` 和 Thought trail 同色板；恢复 Pi 原生 `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` 转圈帧，并让 retry/context compaction 同样推进帧序列---修改 `src/working.ts`、`README.md`、`plan/*`；类型检查、定向 working probe、打包检查、依赖审计、RPC 加载和安装均通过。

2026-08-03 08:30---用户要求 `Worked for Ns` 与 `✦ Thought trail` 对齐并放慢渐变---给 transcript 文案增加两个前导空格；将 macaron shimmer 周期设为约 2.8 秒，工作文案 180ms 更新，spinner 保持原生 80ms 转动---修改 `src/working.ts`、`plan/*`；定向 probe、类型检查、打包检查、依赖审计、RPC 加载和安装均通过。

2026-08-03 08:40---用户要求重写 README 并上传到 GitHub---重写完整中文 README，补充特性、安装、命令、配置、开发、扩展入口和兼容性说明；先配置 HTTPS 远程，因当前环境无 HTTPS 凭据改用已验证的 SSH 认证---修改 `README.md`、`plan/*`，将 `origin` 切换为 `git@github.com:Jielumoon/pi-jielumoon-tui.git`；类型检查、打包检查、依赖审计、RPC 加载均通过，并以 `--force-with-lease` 覆盖远程 `master`，远程提交为 `a21932f`。

2026-08-03 09:00---用户发现 Working 与结束后的上下文彩条分布跳变---确认 Pi 的 `context.messages` 是完整请求上下文，而 `agent_end.messages` 仅为本次 agent run 新增消息；结束后不能将后者拿来重算角色比例---修改 `src/nano-context.ts`，在 `agent_end` 复用最后一次完整 context 快照并更新最新 usage 总量；类型检查、打包检查、依赖审计、事件语义检查和 RPC 加载均通过。

2026-08-03 09:20---用户指出项目未采用标准单入口扩展结构---新增 `src/index.ts` 统一注册 5 个自有模块，将 `package.json` 的自有资源收敛为单入口；bundled `@narumitw/pi-usage` 按 Pi Package 规则保留独立入口---修改 `src/index.ts`、`package.json`、`README.md`、`AGENTS.md`；类型检查、打包检查、依赖审计、manifest 断言、包级 RPC 加载、命令唯一性检查和本地安装均通过。

2026-08-03 09:40---用户同意建立测试结构并要求评估 pi-open-tui 输入框---新增 `tsx` 测试脚本和 Footer 排版、usage 增量、Working spinner/transcript、单入口 manifest 共 7 项回归测试；Pi 0.83 核心包作为开发依赖，使独立开发环境可执行测试和类型检查---修改 `package.json`、`package-lock.json`、`tsconfig.json`、`tests/*`、`README.md`、`AGENTS.md`；测试与类型检查通过。`npm audit --omit=dev` 发现 bundled `pi-usage` 的 Pi peer 依赖链中 `brace-expansion`/`undici` 上游高危公告，自动修复会降级 Pi 到不兼容版本，未执行强制修复，等待处理策略确认。

2026-08-03 10:00---用户确认添加 Sakura 输入框---新增继承 `CustomEditor` 的 `SakuraEditor`，仅包一层 macaron 圆角框；保留 Pi 输入、补全、粘贴、历史与快捷键，窄宽度退回原生框，已有自定义 Editor 时自动让位且关闭时不误清理后来扩展的 Editor---新增 `src/sakura-editor.ts`、`tests/sakura-editor.test.ts`，并修改 `src/index.ts`、`README.md`、`AGENTS.md`、`package.json`；11 项测试、类型检查、打包检查、RPC 加载及本地 `pi install` 均通过；隔离的发布 tarball 生产依赖审计为 0 vulnerabilities，根目录审计仅保留 Pi 0.83 上游公告。

2026-08-06 --- readmap 工具结果可视化差，需要在 pi-jielumoon 内接管 renderer --- 新增 readmap-renderers：通过 hashline:tool-executors / globalThis / registerTool 观察器只替换 renderCall/renderResult，自研 DiffBody 与四工具内容渲染，尊重 diffDisplay/previewLines --- 改了 src/readmap-renderers.ts、src/index.ts、tests/readmap-renderers.test.ts、plan/2026-08-06-readmap-renderer/*、docs/work.md

2026-08-06 --- write/edit 默认展示过多，bash 长输出应先预览再折叠 --- 取消 settings.diffDisplay 强行全开；edit/write 折叠 diff 预览 8 行；write 默认只摘要、展开最多 12 行；bash 短输出阈值 12 行、长输出先预览 12 行 --- 改了 src/readmap-renderers.ts、tests/readmap-renderers.test.ts

2026-08-06 --- readmap 视觉已由 pi-jielumoon 接管，settings 里视觉项会干扰默认折叠 --- 清空 ~/.pi/agent/hashline-readmap/settings.json 中的 edit.diffDisplay / display.previewLines（文件仅剩空对象，执行类配置未动） --- 改了 ~/.pi/agent/hashline-readmap/settings.json

2026-08-06 --- 审查发现视觉配置热路径、write 空行丢失及 registerTool 重载链兼容问题 --- 删除 readmap 视觉设置解析（减少 52 行同步 I/O）；write 保留合法空行；registerTool 始终包裹当前函数，避免 pi-tool-display 等后来拦截器在 /reload 后被跳过；新增两项回归测试 --- 改了 src/readmap-renderers.ts、tests/readmap-renderers.test.ts

2026-08-06 --- 用户确认接管 ls --- 新增 ls 路径/`glob`/`limit` 调用行、目录/文件类型标记、折叠前 12 项预览、展开列表、空目录、截断和错误状态；保留原 execute 与结果数据 --- 修改 src/readmap-renderers.ts、tests/readmap-renderers.test.ts、handoff/readmap-renderer.md、plan/2026-08-06-readmap-renderer/*、docs/work.md；24 项测试、类型检查、打包检查和 diff 空白检查通过。

2026-08-06 --- 用户指定自研 Codex、Anthropic、OpenRouter、xAI/Grok 用量 --- 新增本地订阅用量 Provider、官方域名校验、OAuth/API key 认证解析、60 秒缓存与退避、Footer usage 状态和 `/usage` 命令；移除 `@narumitw/pi-usage` 及其 UI 依赖，保留会话 token/cost 统计 --- 修改 src/footer/subscription-usage.ts、src/index.ts、package.json、package-lock.json、README.md、tests/package.test.ts、tests/subscription-usage.test.ts、plan/*

2026-08-06 --- 用户反馈订阅额度位于左侧扩展状态行太丑、右侧留白 --- 将额度从通用 status 文本改为结构化 `SubscriptionUsageSource`，直接供 Footer 右侧模型区渲染；宽屏与 Provider/Model 同列，空间不足时右对齐独立行，窄屏省略重置时间；统一重置文案为 `↻ 1h` 并保留有效缓存以避免 429 闪烁 --- 修改 src/footer/subscription-usage.ts、src/footer/render.ts、src/footer/types.ts、src/vibrant-footer.ts、src/index.ts、tests/footer-format.test.ts、tests/subscription-usage.test.ts、README.md、plan/*、docs/work.md；33 项测试和类型检查通过。

2026-08-06 --- 用户目视确认额度放在右侧模型区仍不妥且 `1w` 丑 --- 将结构化额度从右侧 metadata 改为左侧 session metrics 的 `cost/sub` 后一段、elapsed 前一段；窗口标签统一使用 `7d`；删除右对齐换行分支，保持数据流简单 --- 修改 src/footer/render.ts、src/footer/subscription-usage.ts、tests/footer-format.test.ts、tests/subscription-usage.test.ts、README.md、plan/*、docs/work.md；33 项测试和类型检查通过。

2026-08-06 --- 用户要求全修本轮与 `b46acae` 审查问题 --- 在 readmap 的调用参数、工具结果、diff、ls 条目等外部文本边界移除终端控制序列，阻断 OSC/CSI 注入；429 在已有缓存时保持 ready 状态；四家 Provider 的周标签统一为 `7d`；`/usage` 失败时给出提示；删除遗留 status formatter 和重复时间分支 --- 修改 src/readmap-renderers.ts、src/footer/subscription-usage.ts、tests/readmap-renderers.test.ts、tests/subscription-usage.test.ts、plan/*、docs/work.md；35 项测试、类型检查、打包检查、生产依赖审计和 diff 空白检查通过。

2026-08-07 22:15---用户批准预览美化 P0：去重复摘要、gutter 对齐、统一折叠提示---删除 edit/overwritten write 的重复 diff 摘要；用 `visibleWidth` 对齐 diff/hashline gutter 与路径；统一 `showing X of Y` 提示并补 Unicode/排版回归---修改 src/readmap-renderers.ts、tests/readmap-renderers.test.ts、plan/task_plan.md、plan/progress.md、docs/work.md；36 项测试、类型检查和打包检查通过。

2026-08-07 22:40---用户要求继续完成 P1/P2 预览美化---增加 hashline 三段着色、Bash stdout 层级与 exit/耗时摘要、ls 宽屏双列和 CJK 裁剪；按 feature-detect 支持 hunk/inline span、split/compact/summary 降级、whitespace/bidi 诊断和 plain/screen-reader 标签；使用 Pi 原生 `toolDiffAdded`/`toolDiffRemoved` 颜色并保留无色安全回退---修改 src/readmap-renderers.ts、tests/readmap-renderers.test.ts、plan/findings.md、plan/progress.md、plan/task_plan.md、docs/work.md；38 项测试、类型检查、打包检查、依赖审计和 diff 空白检查通过。

2026-08-07 23:55---未提交预览美化审查发现测试伪造宿主字段、split 错配、ls 计数错误、大数组栈溢出和无障碍模式未贯通---按 Pi 0.83 真实契约把宽度排版延迟到 `Component.render(width)`，使用 `inlineDiffs` 索引配对 split，修复双侧 hunk/ls 计数/reduce 扫描，删除不存在的 Bash metadata，并让 readmap 与 message-borders 共享输出模式---修改 src/readmap-renderers.ts、src/message-borders.ts、src/render-mode.ts、tests/readmap-renderers.test.ts、plan/task_plan.md、plan/progress.md、docs/work.md；40 项测试、类型检查、打包检查、依赖审计、diff 空白检查、RPC 加载和真实伪终端 `/reload` 检查通过。
2026-08-08 23:48---用户要求思维链不要固定展示最早内容，流式过程应像滚动窗口并最终停在底部---Thought trail 改为只保留最新 16 行，折叠提示移到顶部并保留步骤 rail；新增回归测试确认首行淘汰且最后一行是最新思考---修改 src/thinking-message.ts、tests/thinking-message.test.ts、docs/work.md。
2026-08-09 02:59---按审查建议收缩 Thought trail 尾部滚动实现---删除逐行 `stepIndex` 元数据与提示 rail 分支，改用可见步骤计数恢复树形 rail，保持最新 16 行和底部停留行为不变---修改 src/thinking-message.ts、docs/work.md；定向思维链测试和类型检查通过。

2026-08-10 00:46---TUI 各组件同时使用满宽渐变框、重复状态语义、全宽 context 背景条和多重动画，视觉层级失衡---实施 Sakura Quiet：用户消息改单 rail，工具改 canonical inline header/self shell，Footer 建立两行左右锚点，Nano context 改 compact gauge，Working 收敛为单动画源，并按工具类型调整预览密度；明确保持 Thinking 不动---修改 `src/message-borders.ts`、`src/readmap-renderers.ts`、`src/footer/render.ts`、`src/nano-context.ts`、`src/working.ts`、`tests/footer-format.test.ts`、`tests/readmap-renderers.test.ts`、`tests/working.test.ts`、`README.md`、`docs/work.md`、`plan/2026-04-09-tui-visual-research/*`。

2026-08-10---用户目视反馈工具边框与 Footer 指标颜色被过度削弱---Read 继续无框并统一左缩进 2 格；Edit、Write、Bash、Ls 及其它工具恢复单层 Sakura 完整边框且不重复 COMPLETE 标题；输入输出 token、缓存、命中率、费用与健康订阅额度恢复语义颜色---修改 `src/message-borders.ts`、`src/footer/render.ts`、`tests/readmap-renderers.test.ts`、`tests/footer-format.test.ts`、`README.md`、`docs/work.md`、`plan/2026-04-09-tui-visual-research/*`；45 项全量测试、类型检查、打包检查、生产依赖审计与 Pi RPC 加载通过。

2026-08-10---用户要求工具摘要嵌入边框、运行态使用 Pi spinner，并为用户消息恢复可辨识边框---所有有框工具将唯一 canonical header 嵌入 Sakura 上边框；运行态跨工具复用 80ms Braille spinner；用户消息改为无标题圆框与粉色粗 rail，区别于工具状态卡---修改 `src/message-borders.ts`、`src/gradient.ts`、`src/working.ts`、`tests/readmap-renderers.test.ts`、`README.md`、`docs/work.md`、`plan/2026-04-09-tui-visual-research/*`。

2026-08-10---实机截图暴露 Bash、Todo 等默认工具背景泄漏，用户框左边线断开，且正文紧贴标题上框---统一移除工具卡 background SGR 并保留前景语义色；工具有正文时在标题下增加一行内边距；用户消息改为完整外框并将粉色粗 rail 移入框内---修改 `src/message-borders.ts`、`tests/readmap-renderers.test.ts`、`README.md`、`docs/work.md`、`plan/2026-04-09-tui-visual-research/*`；45 项全量测试、类型检查、打包检查、生产依赖审计、Pi RPC 加载及 Thinking 边界检查通过。

2026-08-10---用户反馈溢出标题上框缺少封口余量、极窄内容风险及 Blackhole 消失---工具标题按可见宽度以 `…` 截断并保留右侧横线/角；用户消息和 Editor 覆盖 paste、长 ASCII/CJK，Editor 小于 7 列回退原生以规避双宽字符换行递归；Blackhole 有配置快照时恢复常态显示---修改 `src/message-borders.ts`、`src/sakura-editor.ts`、`src/footer/render.ts`、`tests/readmap-renderers.test.ts`、`tests/sakura-editor.test.ts`、`tests/footer-format.test.ts`、`README.md`、`docs/work.md`、`plan/2026-04-09-tui-visual-research/*`；47 项全量测试、类型检查、打包检查、生产依赖审计、Pi RPC 加载及 Thinking 边界检查通过。

2026-08-10---可完整容纳的 Bash 命令仍被误判为溢出，标题尾部出现大段空格与 `…`---区分独立 `BashExecutionComponent` 与通用 `ToolExecutionComponent` 路径，确认宿主 Text 行尾 padding 污染标题预算；在统一 `titleBorder()` 入口剥离尾空格并保留 ANSI reset，只对真实超长标题省略---修改 `src/message-borders.ts`、`tests/readmap-renderers.test.ts`、`docs/work.md`、`plan/2026-04-09-tui-visual-research/*`；190 列实机同型 fixture 显示完整命令、`visibleWidth=190`、`ellipsis=false`，47 项全量测试、类型检查、打包检查、生产依赖审计、Pi RPC 加载及 Thinking 边界检查通过。

2026-08-10---合并代码审查发现真实水平线输出会被边框清理误删、异常扩展状态被健康关键词吞没，且存在无效设置、窄宽与死代码问题---宿主 chrome 每侧只剥一层；健康状态改精确白名单；Footer/Nano 共享 Context 设置；补齐 User 窄宽回退、空 Footer、Ls 默认路径和 plain 排版；改用 Pi TUI 宽度工具并删除 Footer context 死链及一次性抽象---修改 `.gitignore`、`src/index.ts`、`src/vibrant-footer.ts`、`src/footer/{render,types,usage}.ts`、`src/nano-context.ts`、`src/message-borders.ts`、`src/readmap-renderers.ts`、`tests/{footer-format,readmap-renderers}.test.ts`、`README.md`、`docs/work.md`、`plan/*`；49/49 测试、类型检查、打包检查、0 漏洞审计、RPC 加载、diff 空白与 Thinking 边界检查通过。

2026-08-10---用户截图证明有框 split diff 的右 pane 在边界直接丢失 `Thinking`、`边界检查`、`ellipsis=false` 尾部字符---确认宿主 renderer 按完整终端宽度排版后，外层 Sakura rail 又占用 3 列并硬截右端；改为渲染前先扣除装饰预算：Read 2 列、有框 Tool/Bash 3 列，让正文在真实内宽内完成换行---修改 `src/message-borders.ts`、`tests/readmap-renderers.test.ts`、`docs/work.md`；179–183 列同型 fixture 均为 `Thinking=true` 且不越界，49/49 测试、类型检查、打包检查、0 漏洞审计与 Pi RPC 加载通过。

2026-08-10---用户反馈图片 Read 因图片旁路缺少普通 Read 的 2 格缩进，并要求文件目标与 Edit 变更统计建立颜色层级---Read 图片结果只缩进可见摘要，Kitty/iTerm 图片控制序列原样保留；Read/Edit/Write/Ls 路径统一使用主题 `syntaxType`，Read `:410–564` 使用 `syntaxNumber`，Edit/覆盖 Write 的 `+N −N` 使用 `toolDiffAdded/toolDiffRemoved`---修改 `src/message-borders.ts`、`src/readmap-renderers.ts`、`tests/readmap-renderers.test.ts`、`docs/work.md`；49/49 测试、类型检查、打包检查、0 漏洞审计与 Pi RPC 加载通过。
2026-08-11 02:00---用户希望偶尔恢复 Pi 工具内容区域的状态底色---在现有 Footer 配置中增加默认关闭的 `toolBackground` 开关；有框工具按运行中/成功/失败使用 Pi 主题底色铺满内层，Read、图片、plain 与 screen-reader 保持无底色，并让缓存感知运行时切换---修改 `src/footer/types.ts`、`src/index.ts`、`src/message-borders.ts`、`tests/footer-format.test.ts`、`tests/readmap-renderers.test.ts`、`README.md`、`docs/work.md`；51/51 测试、typecheck、pack:check、0 vulnerabilities、RPC get_state 和 git diff --check 全部通过。
2026-08-11 02:19---用户反馈工具状态底色左右越界且底部贴得太紧---底色只包裹左右 Sakura rail 之间的内宽，并在正文与底框之间增加一行内层留白；同步补充边界与底部留白回归断言---修改 `src/message-borders.ts`、`tests/readmap-renderers.test.ts`、`docs/work.md`；Readmap 21/21 定向测试通过。
2026-08-11 02:32---用户要求工具卡左侧少一格留白---移除状态 rail 后的额外空格，将有框工具 chrome 从 3 列改为 2 列并同步正文宽度预算与 split diff 断言---修改 `src/message-borders.ts`、`tests/readmap-renderers.test.ts`、`docs/work.md`；Readmap 21/21 定向测试通过。
2026-08-11 16:19---代码审查发现主题切换后工具缓存可能复用旧底色、Bash 底色路径缺少回归覆盖及过多命令别名---改用实时 `ctx.ui.theme` 并把主题身份纳入 Tool/Bash 缓存键；补充 Bash 成功/取消态与 40/80/160 列测试，命令别名收敛为 `tool-bg`，移除过期 handoff 工件---修改 `src/message-borders.ts`、`src/footer/types.ts`、`tests/readmap-renderers.test.ts`、`tests/footer-format.test.ts`、`docs/work.md`；定向 33/33 测试通过。

2026-08-11 16:56---用户截图暴露工具框右侧边界偶发缺块/多块，且运行态右下角持续闪烁---将边框角点拆为静态 Sakura solid，横线内部保留渐变；统一 frame 宽度取整，修复超宽回退时截掉右 rail 的问题，并覆盖 CJK/Emoji/ANSI、运行 spinner 与两侧角点回归---修改 `src/gradient.ts`、`src/message-borders.ts`、`tests/readmap-renderers.test.ts`、`docs/work.md`；53/53 测试、类型检查、打包检查、0 漏洞审计、RPC get_state 与 diff 空白检查通过。

2026-08-11 18:46---用户确认右边界修复，但运行态超长底边仍整块闪烁---结合 Pi TUI 增量渲染确认运行 spinner 会持续刷新标题，而逐字符 Truecolor 横线会把 180 列边框膨胀到约 3.4–4.0 KB；运行态上下横边改为单段静态 Sakura 色，仅 spinner 动画，完成态继续保留渐变；180 列运行底边降至 564 bytes，并补充低刷写量回归---修改 `src/message-borders.ts`、`tests/readmap-renderers.test.ts`、`docs/work.md`；53/53 测试、类型检查、打包检查、0 漏洞审计、RPC get_state 与 diff 空白检查通过。