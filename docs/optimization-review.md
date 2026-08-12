# 全面优化审查(2026-08-13)

对 `src/`(约 4900 行)与 `tests/`(约 2500 行)的逐文件审读结果,附本机实测验证。按"实测问题 → 性能 → 结构 → 健壮性 → 测试 → 工程化"组织,每条给出证据位置、建议与预期收益,末尾有优先级路线图。

> **落实状态(2026-08-13 当日)**:除以下三项外全部落地,84/84 测试通过——
> ① 2.4 中"运行态 Bash 卡的 body 缓存"(文档已标注可选、需谨慎,建议单独提交);
> ② 3.3 Tool/Bash 缓存样板抽取(纯等价重写,现有实现已被回归锁定,收益仅为可维护性);
> ③ 6.4 `docs/work.md` 按月拆分(涉及个人日志组织习惯,留给维护者决定)。
> 裸 `assert.ok` 补 message 仅覆盖 `tests/readmap-renderers.test.ts`(37 处):触发 Node 24 死循环需要文件超过 32 KiB 读取分块边界,其余测试文件体量不足、物理上无法触发;新增测试均自带 message。
> 结构拆分按维护者要求落在 `src/readmap-renderers/` 目录(而非文档草案的 `src/readmap/`),避免与他人 readmap 项目重名。

## 0. 验证基线

本次审查在写结论前先复核了仓库的标准校验(AGENTS.md 四件套):

| 检查 | 环境 | 结果 |
| --- | --- | --- |
| `npm test` | Node 22.22.3,未设 `NO_COLOR` | 63/63 通过,约 2.5s |
| `npm test` | Node 22.22.3,`NO_COLOR=1` | **56 通过 / 7 失败**(见 1.1) |
| `npm test`(readmap 文件) | Node 24.5.0 / 24.18.0,`NO_COLOR=1` | **测试 worker 死循环,100% CPU,SIGTERM 杀不掉**(见 1.2) |
| `npm run typecheck` | tsc 7.0.2 | 通过 |
| `npm run pack:check` | — | 22 个文件,tarball 59.6 kB |
| `npm audit --omit=dev` | — | 0 漏洞 |

代码本体质量很高:增量 usage 累计、写入动画的共享调度器、订阅额度的缓存/退避、外部文本控制序列净化、原型补丁注册表的幂等与清理,都是认真设计过的。下面的问题多数是"下一层"的改进,但第 1 节是实打实的缺陷。

## 1. 实测发现的问题(P0)

### 1.1 测试对环境变量敏感:`NO_COLOR=1` 时 7 个测试失败

**现象**:在设置了 `NO_COLOR`(以及 `TERM=dumb` 一类)的环境跑 `npm test`,7 个测试失败,失败点全部是"缺少 `✓` 阶段标记 / 缺少语义颜色 / write 动画未启动"。

**根因**:`src/render-mode.ts` 的 `resolveRenderMode()` 在 `NO_COLOR` 存在时返回 `plain`——这是产品上正确的行为;但 `tests/readmap-renderers.test.ts` 中大量断言隐式假设默认模式是 `color`。文件里已有 `withEnv()` 辅助函数(第 58 行)给 plain/screen-reader 用例显式设值,唯独"默认 color"这个前提没有被固定。

**受影响测试**:`read renderer respects collapsed summary`、`P0 keeps diff and hashline gutters aligned`、`P1/P2 styles hashline segments`、`edit renderer collapses by default`、`write call animates incrementally`、`parallel write calls`、`shared write timer`。

**建议**:

1. 在每个渲染相关测试文件顶部(或统一的 setup 模块)固定基线:

```ts
process.env.PI_READMAP_RENDER_MODE = "color";
delete process.env.NO_COLOR;
```

`resolveRenderMode()` 每次调用都读 env,顶部设置即可全局生效;现有 `withEnv("PI_READMAP_RENDER_MODE", "plain", ...)` 的显式用例不受影响。
2. 或者在 `package.json` 的 test script 里注入:`"test": "cross-env-shell ..."` 不必引依赖,直接 `PI_READMAP_RENDER_MODE=color tsx --test tests/*.test.ts` 即可(CI 与本地统一)。

**收益**:测试变得密闭(hermetic),任何终端、CI runner、代理沙箱里结果一致。这也是 1.2 死循环的直接触发前提。

### 1.2 Node 24 下失败的 `assert.ok` 触发 Node 内部死循环,测试进程僵死且杀不掉

**现象**(Node 24.5.0 与 24.18.0 均复现):`NO_COLOR=1` 时跑 `tests/readmap-renderers.test.ts`,worker 进程 100% CPU 永不结束;`timeout`/SIGTERM 只能杀掉父进程,worker 变成孤儿继续空转(信号处理被死循环阻塞,只有 SIGKILL 有效)。本次审查期间累计产生了 8 个这样的孤儿进程。

**根因**(用调试器附加空转进程抓到的调用栈):

```text
ok (node:assert:157)
→ innerOk → getErrMessage → getCode
→ findColumn (node:internal/assert/utils:77)   ← 1800+ 帧,无限递归
调用点: tests/readmap-renderers.test.ts:1:34406 = assert.ok(tick)(源文件第 1125 行)
```

不带 message 的 `assert.ok(expr)` 失败时,Node 会回读源文件把表达式文本拼进错误消息。tsx/esbuild 转译后调用点位置被记为"第 1 行第 34406 列",而磁盘上的原始 TS 文件第 1 行只有几十个字符;Node 24 的 `findColumn` 在这种位置错位下无限递归(疑似与读取分块边界有关:该文件 56 KB,出问题的列号 34406 恰好越过 32 KiB;列号更小的同类失败断言能正常退出)。Node 22 的实现能优雅回退,同样条件下只是正常报错。

触发链:`NO_COLOR` → plain 模式 → write 动画不调度 → `tick` 为 undefined → `assert.ok(tick)` 失败 → 消息生成死循环。

**建议**(按性价比排序):

1. 落实 1.1,失败本身就不会发生——这是治本的第一步。
2. 给裸 `assert.ok(x)` 补第二个参数。全仓库单参数 `assert.ok` 共 61 处(readmap 37、footer-format 20、sakura-editor 9 等)。带 message 的断言完全跳过源码回读路径,同时报错可读性也更好。可以只优先处理 readmap 这个 56 KB 大文件(唯一超过 32 KiB 边界的测试文件)。
3. CI 加 Node 22 + 24 矩阵(见第 7 节)——这个问题只在 Node 24 出现,单一版本的本地验证永远发现不了。
4. 可选:向 nodejs/node 上报 `findColumn` 无限递归(复现条件:tsx 转译的 TS 测试文件 > 32 KiB、失败的无消息 `assert.ok` 位于高列偏移处)。

### 1.3 附带观察:测试直接替换 `globalThis.setInterval`

`shared write timer isolates a failing component`(readmap 测试第 1100–1136 行)手工 stub 全局 `setInterval`/`clearInterval`。这次的死循环不是它导致的,但全局替换在与 runner 内部计时器共存时是脆弱模式,建议改用 `node:test` 自带的 `t.mock.timers.enable({ apis: ["setInterval"] })`,作用域和还原都由框架保证。

## 2. 性能热点

### 2.1 Blackhole 采集:每次 Footer 刷新做 2 次同步文件读 + 全分支 token 重估

`src/footer/blackhole.ts` 的 `collectBlackholeStatus()`(第 179 行)每次执行:

- `readFileSync` 读 `pi-blackhole-config.json`(第 182 行)+ `pi-blackhole-cooldown.json`(第 31 行);
- `summarizeBlackholeBranch()` 对当前 branch 每个条目调 `estimateTokens`/长度估算(第 108–177 行)。

而它的调用方 `refreshSnapshot`(`src/vibrant-footer.ts` 第 42 行)挂在 `context`、`message_end`、`agent_end`、`session_compact` 等高频事件上。长会话(数百条 entry)时,每条消息结束都要在 TUI 线程上同步做一遍 O(branch) 扫描 + 磁盘 I/O。`docs/work.md` 2026-08-03 已记录过一次 Footer 阻塞排查,这里是同一类残留成本。

**建议**(全部保持"每次基于当前 branch 重算"的实时语义,只消除重复计算):

1. 配置文件加 mtime 缓存:`statSync` 比较 mtime,未变化就复用上次解析结果。两个 JSON 都适用(cooldown 文件的 `until` 是绝对时间戳,复用解析结果不影响剩余时间计算)。
2. entry 级 token 估算加 `WeakMap<object, number>` 缓存:session entry 是追加不变的对象,`estimateBlackholeEntryTokens` 对同一 entry 的结果永远相同。当前实现只在单次刷新内去重,跨刷新全部重算;WeakMap 缓存后每次刷新只需为新增 entry 估算,复杂度从 O(branch) 降到 O(新增)。
3. 观察项聚合(`observations`/`dropped` 两个 Map/Set)同理可增量维护,但改动面大、收益边际,建议先做前两条。

**收益**:Footer 刷新从"每事件全量扫描"变成近似 O(1),长会话中键入延迟与渲染抖动的主要来源之一被消除。

### 2.2 diff 渲染:`inlineText` / `hunkLabel` 对每个条目线性扫描,复杂度 O(n·m)

`src/readmap-renderers.ts` 第 917–948 行,`inlineText()` 对每个 diff entry 在 `diffData.inlineDiffs` 数组上做 `find`;第 949–967 行 `hunkLabel()` 同样对每个 entry 扫 `blockRanges`。split 模式其实已经预建了 `splitPairs` Map(第 892–907 行),但 `inlineText` 没有复用它。

展开一个几百行、带大量 inline span 的 diff 时,这是平方级开销,且发生在每次宽度变化的重排上。

**建议**:进入 `renderDiffLines` 时一次性建三个索引——`Map<removeLineIndex, InlineDiff>`、`Map<addLineIndex, InlineDiff>`、`Map<startLine, DiffBlockRange>`(按 kind 分桶)——之后全部 O(1) 查找。改动局部,测试已有 `P2`/`P3` 用例保护。

### 2.3 订阅额度:事件风暴下的请求抖动与 xAI 串行请求

`src/footer/subscription-usage.ts`:

1. `refresh()`(第 726 行)开头无条件 `this.activeController?.abort()`。`session_start`、`turn_start`、`agent_end`、`model_select`、`session_tree` 都触发 refresh,若上一个请求还在飞(接口通常几百毫秒~几秒),连续事件会反复"中止再发起",冷启动时可能连发多次都取不回结果。
   **建议**:改 single-flight——相同 cacheKey 的在飞请求直接复用其 Promise,只有模型身份变化才 abort。
2. `fetchXai()`(第 573–583 行)串行请求 monthly 和 weekly 两个端点,总延迟翻倍。
   **建议**:`Promise.allSettled` 并行,保留"monthly 401/403 才致命"的现有语义。
3. 小项:`cache`/`failureUntil` 两个 Map 只在 shutdown 清空,频繁换模型/换 key 的会话里无上限增长(实际量级很小,顺手加个上限即可)。

### 2.4 每帧重复计算的小热点(单项都小,叠加可观)

| 位置 | 问题 | 建议 |
| --- | --- | --- |
| `src/thinking-message.ts` 第 274–284 行 | `render` 补丁对每帧、每条助手消息全量 `recolorHiddenThinkingLines`(逐行 stripAnsi + 正则) | 按 `lines` 数组身份加 WeakMap/单槽缓存;未变化直接返回 |
| `src/vibrant-footer.ts` 第 109 行 | 每帧调 `getIcons()` → `hasNerdFonts()` 反复读多个 env | 模块级算一次缓存(env 运行期不会变) |
| `src/footer/render.ts` 第 249–255 行 | `isQuietExtensionStatus` 每次调用 `new RegExp` ×2 | 状态正则提为常量;按 key 的正则用 Map 缓存 |
| `src/message-borders.ts` 第 430–467 行 | 运行中的 Bash 卡每帧(80ms spinner)对全部输出行重跑 `stripBackgroundAnsi` + 重排;完成态才有缓存 | 可选:运行态把 header 以外的 body 行按 `outputLines` 身份缓存,只重绘标题行。输出大且滚动慢时收益明显,改动需小心,优先级放低 |

## 3. 结构与可维护性

### 3.1 `readmap-renderers.ts` 已达 1818 行,职责六种

单文件同时承担:终端文本净化、write 流式动画(组件+全局调度器)、diff 渲染(unified/split/compact/summary 四模式)、canonical header、五个工具的 result renderer、patch 安装基础设施。继续演进(比如再接管一个工具)只会更臃肿。

**建议**:拆为 `src/readmap/` 子目录,与现有 `footer/` 的组织方式对称:

```text
src/readmap/
  sanitize.ts       # sanitizeTerminalText、displayText、BIDI 表
  write-stream.ts   # WriteCallComponent、advanceWriteReveal、动画调度器
  diff.ts           # DiffData 类型、renderDiffLines、DiffBodyComponent
  header.ts         # toolSubject、renderToolHeader、phaseMarker
  results.ts        # renderRead/Edit/Write/Bash/LsResult、renderToolError
  patch.ts          # patchReadmapTool、registerTool 观察器、入口
```

纯机械搬移,公开导出(`patchReadmapTool`、`advanceWriteReveal` 等)从入口 re-export,1568 行的既有测试全程护航。建议独立成一次不改行为的提交。

### 3.2 跨文件重复的工具函数(约 10 处)

| 重复项 | 位置 | 建议 |
| --- | --- | --- |
| `stripAnsi`(完全相同的正则对) | `thinking-message.ts:36`、`sakura-editor.ts:16`、`message-borders.ts:105`(+ 测试 1 份) | 收敛到 `src/ansi.ts`;注意与 readmap 的 `sanitizeTerminalText` 语义不同(前者剥样式、后者防注入),不要合并这两者 |
| `isObject`/`asRecord`/`asObject`/`isRecord` | `message-borders.ts:101`、`readmap-renderers.ts:391,1627`、`footer/blackhole.ts:21`、`footer/subscription-usage.ts:101`、`nano-context.ts:60` | 收敛到 `src/guards.ts`,统一命名 |
| `estimateTextTokens`(length/4) | `footer/blackhole.ts:52`、`nano-context.ts:48` | 共享一份,常数 4 只声明一次 |
| 时长格式化 ×4 | `footer/format.ts:16 formatDuration`、`working.ts:19 formatElapsed`、`footer/blackhole.ts:223 formatCooldownDuration`、`footer/subscription-usage.ts:140 formatUsageReset` | 输出风格刻意不同(`1h2m` / `1m 5s` / 向上取整 / `now·d`),不必强行合一,但建议集中到一个 `duration.ts` 并用注释标明各自面向的 UI 场景,避免第五次重造 |
| 尾部 padding 剥离 | `thinking-message.ts:46 removeTrailingPadding` 与 `message-borders.ts:115 trimTerminalPadding`(语义几乎相同) | 合并进 `ansi.ts` |

### 3.3 `message-borders.ts` 的 Tool/Bash 两套缓存样板几乎相同

第 495–551 行(Tool)与第 580–630 行(Bash)是同构的"读缓存 → 判等 → 调 predecessor → 装饰 → 写缓存"流程,字段逐个手写比较,新增缓存键(上次就因主题切换漏过一次,见 work.md 2026-08-11)容易遗漏。

**建议**:抽一个 `memoizeRender<TKey>(cacheMap, computeKey, render)` 帮助函数,键的判等集中在一处;或至少把"键对象 + 浅比较"提出来共用。

### 3.4 其它结构小项

- `footer/subscription-usage.ts`(842 行)里四个 provider 的 normalizer 是纯函数,与 controller 生命周期代码可拆成 `providers.ts` + `controller.ts`,测试导入面也更清晰。
- `gradient.ts` 的 `gradientCache`(第 75–78、112–115 行)是 FIFO 而非 LRU:命中不刷新新鲜度,极端情况下常用条目可能被轮换出去。规模只有 256,影响极小,但改成"命中时 delete+set"只要两行,顺手即可。
- `nano-context.ts` 的 `foreground()`(第 51 行)与 `gradient.ts` 的 RGB 前景函数重复(hex 与元组两种入参),可统一。

## 4. 健壮性与一致性小项

1. **命名误导**:`subscription-usage.ts` 第 295 行 `const windowMinutes = asNumber(data.limit_window_seconds)`——变量存的是秒,换算(`Math.ceil(windowMinutes / 60)`)是对的,名字是错的。改名 `windowSeconds`。
2. **spinner 节奏来源不一致**:`working.ts` 第 64–83 行的 retry/compaction spinner 按 `updateDisplay` 调用次数推帧(`spinnerTicks`),而 `gradient.ts` 的 `renderSakuraSpinner` 按 `Date.now()` 推帧。宿主调用频率变化时两者转速会不同步。建议 Loader 补丁也改为按时间取帧,顺带能删掉 WeakMap。
3. **文案语言混用**:`footer/render.ts` 第 127 行硬编码中文 `"余额 "`,同一行的其它 window 标签(`7d`、`Key`)是英文。统一其一(建议英文 `bal`,与紧凑风格一致)。
4. **`vibrant-footer.ts` 第 67 行**:30s 刷新 `setInterval` 没有 `.unref()`;同文件的订阅模块计时器都 unref 了。TUI 场景无实际影响,但一致化可避免非 TUI 模式下的潜在退出阻塞。
5. **`footer/settings.ts` 第 84–87 行**:设置面板用"重新格式化标签再字符串比对"的方式反查选中项,标签文案一变就断。`ctx.ui.select` 若支持返回索引,改用索引;否则至少用 `Map<label, definition>` 生成与查找同源。
6. **`readmap-renderers.ts` 第 1740–1743 行**:`patchToolPayload` 会在工具对象缺 `name` 时用 payload 的 key 回填并直接改写外部对象,副作用建议在函数 doc 注释里写明(行为本身合理)。

## 5. 测试缺口

现有 63 个测试对渲染路径覆盖扎实,但有三块复杂逻辑完全没有直接测试:

| 缺口 | 为什么值得补 |
| --- | --- |
| `footer/blackhole.ts` `summarizeBlackholeBranch` | 全仓库逻辑密度最高的纯函数之一:coverage index 推进、dropped 观察去重、compaction `firstKeptEntryId` 边界、prefix-sum。纯输入输出,极易测;一旦做 2.1 的缓存改造更需要回归保护 |
| `prototype-patch-registry.ts` | 所有 UI 接管的地基:幂等安装、双扩展抢占、cleanup 顺序、registry 回收。当前只被间接覆盖;它坏掉的表现是"静默回到宿主渲染",人工很难发现 |
| `footer/settings.ts` | `readFooterSettings` 对坏 JSON/非布尔值的容错、`saveFooterSettings` round-trip、命令 alias 解析(`tool-bg`、`write-animation` 等)零覆盖 |

另有两条基础设施建议:

- 落实 1.1 的环境固定后,把"`NO_COLOR=1` 下渲染回退 plain"本身写成一个显式测试(现在这是无意间被 7 个失败"覆盖"的行为)。
- `node:test` 原生支持 `--experimental-test-coverage`,加一个 `npm run test:coverage` 便于观测上述缺口的收敛。

## 6. 工程化

1. **加 CI(收益最大的一条)**。仓库目前没有任何 `.github/workflows`。AGENTS.md 要求的四件套(test / typecheck / pack:check / audit)完全靠人肉执行,而本次 1.2 的 Node 24 问题恰好是"只在另一个 Node 版本出现"的类型。建议:

```yaml
# .github/workflows/ci.yml 核心矩阵
strategy:
  matrix:
    node-version: [22, 24]
steps:
  - npm ci --legacy-peer-deps
  - npm test            # 记得注入 PI_READMAP_RENDER_MODE=color(见 1.1)
  - npm run typecheck
  - npm run pack:check
  - npm audit --omit=dev
```

2. **提交 `.npmrc`**,内容一行 `legacy-peer-deps=true`。README/AGENTS.md 要求记住 `npm install --legacy-peer-deps`,忘记参数时装出来的树不一致;`.npmrc` 让本地与 CI 自动一致。
3. **`package.json` 补发布元数据**:`repository`、`homepage`、`bugs`(README 已给出 GitHub 地址,manifest 里没有)。对 `pi install <github-url>` 的用户与 npm 页面展示都有意义。
4. **`docs/work.md` 管理**:append-only 工作日志已 92 行、单行数百字,继续增长会难以检索。建议按月拆分(`docs/work/2026-08.md`)或倒序排列,最新在顶。

## 7. 优先级路线图

| 优先级 | 事项 | 涉及 | 预估工作量 |
| --- | --- | --- | --- |
| P0 | 1.1 测试固定渲染模式环境 | tests 各文件顶部或 test script | 半小时 |
| P0 | 1.2 裸 `assert.ok` 补 message(至少 readmap 37 处) | tests | 1–2 小时 |
| P0 | 6.1 CI + Node 22/24 矩阵 | `.github/workflows` | 1 小时 |
| P1 | 2.1 Blackhole mtime 缓存 + entry token WeakMap | `footer/blackhole.ts` | 半天(含新增 summarize 单测) |
| P1 | 2.2 diff 索引化,消 O(n·m) | `readmap-renderers.ts` | 1–2 小时 |
| P1 | 5 补 `summarizeBlackholeBranch` / patch-registry / settings 测试 | tests | 半天 |
| P2 | 2.3 订阅 single-flight + xAI 并行 | `footer/subscription-usage.ts` | 半天 |
| P2 | 3.1 拆分 readmap 为子模块 | `src/readmap/` | 半天(纯搬移) |
| P2 | 3.2 合并重复工具函数 | `src/ansi.ts`、`src/guards.ts` 等 | 2–3 小时 |
| P2 | 6.2/6.3 `.npmrc` + package 元数据 | 根目录 | 15 分钟 |
| P3 | 2.4 各帧级微热点、3.3 缓存样板、4 各小项 | 分散 | 按需 |

**建议的落地顺序**:P0 三项一起做(它们互相配合:环境固定消除失败、message 兜底、CI 防回归),之后 P1 的性能与测试项各自独立成小提交,P2/P3 穿插在日常迭代里。每项完成后按 AGENTS.md 跑四件套,涉及真实 TUI 的(2.4 Bash 缓存、3.1 拆分后)另需 `/reload` 目视确认。
