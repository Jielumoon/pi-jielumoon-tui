# readmap 可视化接管扩展交接文档

> 交给下一位 Agent：在 `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon` 内继续实现。本文是当前对话的技术交接，不是 readmap 的 fork 方案，也不是让你修改 readmap `node_modules` 的补丁。

## 1. 任务目标

用户已经安装并使用 `pi-hashline-readmap`，但认为它的工具结果可视化很差。用户希望在现有项目 `pi-jielumoon` 中写一个**独立的 Pi 扩展/模块**，通过 Pi 的 renderer 接口接管或优化 readmap 的 TUI 展示：

- 不 fork `pi-hashline-readmap`。
- 不修改 `~/.pi/agent/npm/node_modules/pi-hashline-readmap`。
- 不重新实现 read/edit/write/bash/ls 的执行逻辑。
- 不破坏 readmap 的 `LINE:HASH` 锚点、编辑安全检查、context hygiene、RTK/bash 处理。
- 只替换工具的 `renderCall` / `renderResult`，让模型可见的 `content/details` 和原有 `execute` 保持不变。
- 充分利用当前项目已有的 Sakura/macaron 工具卡片风格。

用户当前没有给出最终的具体视觉稿，因此下一位 Agent 可以先做一个可验证的 MVP，再根据实际 TUI 截图调整。

## 2. 当前已确认的运行环境

### 项目

- 项目：`/home/jielumoon/opt/projects/pi-tui/pi-jielumoon`
- 当前 Git 状态：`main...origin/master`，工作树在本次交接前干净。
- 项目类型：TypeScript 原生 ESM Pi TUI 扩展。
- Node 要求：`>=22.19.0`。
- Pi 依赖：`@earendil-works/pi-coding-agent >=0.83.0`、`@earendil-works/pi-tui >=0.83.0`、`@earendil-works/pi-ai >=0.83.0`。
- `package.json` 当前只有一个自有入口：`./src/index.ts`；另有 bundled 的 `@narumitw/pi-usage` 入口。
- 当前没有 `handoff/` 目录；本文件就是第一次建立的交接资料。

### 已安装的外部扩展

- `pi-hashline-readmap@0.11.2`
- 代码路径：`/home/jielumoon/.pi/agent/npm/node_modules/pi-hashline-readmap`
- 当前 readmap 配置：`/home/jielumoon/.pi/agent/hashline-readmap/settings.json`

```json
{
  "edit": {
    "diffDisplay": "expanded"
  },
  "display": {
    "previewLines": 0
  }
}
```

这表示用户已经选择：编辑 diff 默认展开；read 的默认尾部预览隐藏。新的 renderer 不应该无声地推翻这两个偏好。

### pi-tool-display 当前配置

配置路径：`/home/jielumoon/.pi/agent/extensions/pi-tool-display/config.json`。

readmap 与 `pi-tool-display` 冲突的内置工具已经关闭接管：

```json
"registerToolOverrides": {
  "read": false,
  "grep": false,
  "find": false,
  "ls": false,
  "bash": false,
  "edit": false,
  "write": false
}
```

因此不要通过重新打开这些值来实现本任务，也不要再注册同名 `read`/`edit`/`write`/`bash` 工具。

## 3. 当前项目已有的 TUI 架构

### 入口

`src/index.ts` 当前顺序：

```ts
installNanoContext(pi);
installFooter(pi);
installThinking(pi);
installMessageBorders(pi);
installWorking(pi);
installSakuraEditor(pi);
```

建议新增一个小模块，例如：

```text
src/readmap-renderers.ts
```

然后从 `src/index.ts` 调用：

```ts
installReadmapRenderers(pi);
```

不要为了这个功能另建一个 npm 包；当前仓库本身就是用户将要加载的扩展包。

### 现有消息/工具卡片补丁

`src/message-borders.ts` 已经做了重要工作：

- 对 `ToolExecutionComponent.prototype.render` 做幂等原型补丁。
- 调用原始 renderer 后，对工具内容加 Sakura 边框和左右 rail。
- 对 `BashExecutionComponent.prototype.render` 重新绘制 Bash 边框。
- 对 `invalidate` / `updateDisplay` 做缓存失效处理。
- 使用 `src/prototype-patch-registry.ts` 处理补丁注册、重复安装和清理。

因此新的 readmap renderer 应该返回**内容组件**，不要自己再包一层完整外框，也不要设置 `renderShell: "self"`，除非经过真实 Pi TUI 验证。否则很容易出现双重边框、Bash 边框失效或 reload 后补丁链混乱。

现有项目风格包括：

- Sakura 渐变 rail 和 macaron 色板。
- 工具状态：running / complete / failed。
- `@earendil-works/pi-tui` 的 `Text`、`Container`、`Markdown`、`truncateToWidth`、`visibleWidth`。
- 宽度安全：每个输出行必须适配真实 render width。
- 缓存：现有工具卡片使用 `WeakMap` 缓存并在 invalidate/update 时清理。

`README.md` 明确说明：当前项目主要负责消息卡片样式，工具内容仍由 Pi/native tool renderer 负责。本任务就是把 readmap 的工具内容 renderer 也纳入当前项目，但执行层仍然归 readmap。

## 4. readmap 已确认的 renderer 接口

Pi 官方扩展类型位于项目依赖的：

```text
node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts
```

`ToolDefinition` 支持：

```ts
renderCall(
  args,
  theme,
  context,
): Component;

renderResult(
  result,
  options,
  theme,
  context,
): Component;
```

其中 `ToolRenderContext` 包含：

- `args`
- `toolCallId`
- `lastComponent`
- `state`
- `cwd`
- `executionStarted`
- `argsComplete`
- `isPartial`
- `expanded`
- `showImages`
- `isError`
- `invalidate`

`ToolRenderResultOptions` 包含：

- `expanded`
- `isPartial`

### readmap 暴露的工具对象

`pi-hashline-readmap/index.ts` 在注册工具后执行：

```ts
(globalThis as any).__hashlineToolExecutors = toolExecutors;
pi.events.emit("hashline:tool-executors", toolExecutors);
```

当前 event 中包含：

- `read`
- `edit`
- `grep`
- `ast_search`
- `write`
- `ls`
- `find`
- 可选 `nu`
- 可选 `context_hygiene_report`

注意：readmap 当前的 `bash` 是通过 `registerBashRendererTool()` 注册的，但 `index.ts` 构造的 `toolExecutors` 对象没有把 Bash 放进去。因此不能只依赖 `hashline:tool-executors` 来接管 Bash。

Pi 的 `ExtensionAPI` 还有公开的：

```ts
pi.getAllTools(): ToolInfo[];
```

`pi-tool-display` 自己就是通过 `pi.getAllTools()` 和注册拦截器发现工具，并对工具对象原地 `Object.assign` renderer。新实现可以：

1. 监听 `hashline:tool-executors`，接管 readmap 明确暴露的工具。
2. 在 `session_start` / `before_agent_start` 或初始加载时调用 `pi.getAllTools()`，按名字补上 `bash`，并作为 reload/加载顺序兜底。
3. 用 `WeakSet` 或 `Symbol` 标记已经接管的工具，避免重复包装。

不要假设 readmap event 是 Pi 核心官方类型；它是 readmap 提供的跨扩展集成钩子。必须做结构检查，event 缺失或 payload 变化时安静降级，不要让整个 Pi 启动失败。

## 5. readmap 工具当前返回的数据

下面这些字段是根据当前 `0.11.2` 源码确认的。新 renderer 只能把它们当作结构化数据的 feature-detected 形状使用，不要直接 import readmap 的私有源码模块。

### `read`

源码：

```text
~/.pi/agent/npm/node_modules/pi-hashline-readmap/src/read.ts
```

结果：

```ts
result.content[0].text                 // LINE:HASH|... 文本
result.details.ptcValue
```

`ptcValue` 当前包含或可能包含：

- `range.startLine`
- `range.endLine`
- `range.totalLines`
- `truncation`
- `symbol`
- `map`
- `warnings`
- 其他 PTC 结构化信息

readmap 自己的 renderer 当前行为：

- 未完成时显示 `pending read`。
- 错误时默认只显示第一行，展开后显示完整错误。
- 成功时显示 loaded 行数、truncated、symbol/map/warning badges。
- 展开后显示完整 hashline 文本。
- 未展开时通过 `previewLines` 显示尾部预览。
- 当前全局 `display.previewLines=0`，所以用户明确关闭了默认尾部预览。

新的 read renderer 可以在不改变内容的前提下改善：

- 文件路径和行区间标题。
- `loaded N lines`、symbol、map、truncated、warning 徽章。
- hash gutter 的视觉层级。
- 展开后的行号/hash/content 对齐。
- 图片结果和非 text content 的安全回退。

### `edit`

源码：

```text
~/.pi/agent/npm/node_modules/pi-hashline-readmap/src/edit.ts
~/.pi/agent/npm/node_modules/pi-hashline-readmap/src/edit-output.ts
```

成功结果当前包含：

```ts
result.content[]
result.details.diff
result.details.patch
result.details.diffData
result.details.firstChangedLine
result.details.ptcValue
result.details.contextHygiene
```

`details.ptcValue` 当前还包含：

- `tool`
- `ok`
- `path`
- `summary`
- `diff`
- `diffData`
- `firstChangedLine`
- `warnings`
- `noopEdits`
- 可选 `semanticSummary`

`diffData` 是最有价值的结构化数据。它有当前 diff renderer 使用的统计和 block/line 信息。不要仅从已经格式化的 `result.content` 反解析 diff。

readmap 自己的 renderer 当前行为：

- partial 时显示 `pending edit`。
- 错误/no-op 时显示摘要，展开后显示更多错误文本。
- 成功时显示 `edited +N -M`、semantic/warning badge。
- 有 `diffData` 且 expanded 时返回 readmap 私有的 `DiffPreviewComponent`。
- 计算 expanded 时同时考虑 Pi `context.expanded` 和 `resolveEditDiffDisplay() === "expanded"`。
- 用户全局已经设置 `edit.diffDisplay=expanded`，所以新 renderer 不能默认把所有 diff 隐藏掉。

### `write`

源码：

```text
~/.pi/agent/npm/node_modules/pi-hashline-readmap/src/write.ts
```

结果详情当前包含：

- `details.diff`
- `details.diffData`
- `details.writeState`: `created` 或 `overwritten`
- `details.ptcValue.lines`: 新文件 hashline 结构
- `details.ptcValue.diffData`
- `details.warnings`
- `details.contextHygiene`

readmap 当前把：

- 新建文件展开时展示内容预览，不使用“全是 add”的 diff chrome。
- 覆盖已有文件时使用 diffData 展示 old/new diff。
- 大内容存在 `CONTENT_PREVIEW_MAX_LINES = 200` 的展示预览限制。

新的 write renderer 应继续区分 created 和 overwritten，不要把纯新建内容渲染成一长串无意义的绿色 `+`。

### `bash`

源码：

```text
~/.pi/agent/npm/node_modules/pi-hashline-readmap/src/bash-renderer.ts
```

当前 Bash 工具是一个 wrapper：

- `execute` 委托给 Pi 原生 `createBashTool`。
- `renderCall` 显示 `bash` 和单行命令。
- `renderResult` 使用 `result.content` 文本。
- 失败时默认摘要，expanded 时显示完整错误文本。
- 成功且无输出时显示 `command completed (no output)`。
- 成功有输出时显示行数；expanded 时显示完整内容。
- collapsed 时使用 readmap `resolvePreviewLines()` 和折叠预览。

用户之前明确表达过：大多数 Bash 命令并不长，希望 Bash 输出更详细，不要过度压缩。因此新 Bash renderer 的方向是：

- 普通短输出尽量直接显示，不要再增加一层极 aggressive 的压缩。
- 保留成功/失败状态、行数、截断/压缩提示。
- 失败输出首行必须可见，expanded 后可看完整错误。
- 遵循 Pi/readmap 的 `expanded` 状态，不要偷偷修改模型收到的原文。
- 注意 readmap 的 RTK 压缩和 bash context guard 已经发生在 execute/result 层；renderer 不应该误称自己恢复了原始输出。

## 6. 推荐的接管实现

### 6.1 只改渲染属性，不改 execute

建议定义结构化的最小类型，避免依赖 readmap 私有类型：

```ts
type PatchableTool = {
  name?: string;
  renderCall?: (...args: any[]) => unknown;
  renderResult?: (...args: any[]) => unknown;
  execute?: (...args: any[]) => unknown;
  [key: string]: unknown;
};
```

实际代码应尽可能使用 Pi 导出的 `ToolDefinition`、`ToolRenderContext`、`ToolRenderResultOptions` 类型；对于 `details.ptcValue` 和 `diffData` 使用本地 `unknown` narrowing。

接管逻辑应遵循：

```text
发现工具对象
  ├─ 工具名不是目标 → 跳过
  ├─ 已被本扩展标记 → 跳过
  └─ 保存原 renderer（只用于必要的 fallback）
       ├─ 替换 renderCall
       └─ 替换 renderResult

execute、parameters、description、renderShell、sourceInfo 全部保留
```

不要把原 `execute` 包一层；本任务不需要工具行为改写。

### 6.2 发现工具对象的顺序

建议组合这几条路径：

1. 扩展初始化时监听：

```ts
pi.events.on("hashline:tool-executors", (payload) => {
  patchPayload(payload);
});
```

2. 使用 `globalThis.__hashlineToolExecutors` 兜底。readmap 可能先于本模块初始化。

3. 在 `session_start` 和必要的 `before_agent_start` 中调用 `pi.getAllTools()`，补 Bash 以及 reload 后重新注册的工具。

4. 调试阶段可打印/通知接管了哪些工具，但默认不要污染用户会话输出。

工具对象可能在 `pi.getAllTools()` 的返回值中被包装或带有 `sourceInfo`。只对确认具备 `renderResult` / `execute` 的对象原地设置 renderer，失败时 catch 并保留原 renderer。

### 6.3 `renderResult` 的通用安全策略

- 优先读取 `result.details` 的结构化字段。
- text content 只做 fallback 或展开正文，不要作为 diff 的唯一数据源。
- `result.isError`、`context.isError`、`options.isPartial` 要优先处理。
- `context.expanded` 优先于 renderer 自己的临时判断；与 readmap 全局配置的关系要明确，不要把用户 `diffDisplay=expanded` 覆盖掉。
- 对没有预期 details 的历史结果、readmap 旧版本结果、第三方工具结果，返回简洁 `Text`，不要抛异常。
- `renderResult` 失败时应尽量退回原 renderer 或纯文本，而不是让 Pi 整个 TUI 崩溃。
- 组件要支持真实宽度；使用 `visibleWidth` / `truncateToWidth` / `wrapTextWithAnsi`，不要用 `string.length` 计算终端宽度。
- 大结果只展示经过限制的预览；完整结果仍由 Pi 的展开机制控制。

## 7. 建议的 MVP 视觉规格

这是实现建议，不是用户已经确认的硬性设计；完成后应以实际截图/手动测试为准。

### 工具调用行

统一为：

```text
◆ READ     path/to/file.ts:20-48       symbol: foo
◆ EDIT     path/to/file.ts             3 edits
◆ WRITE    path/to/new.ts              42 lines · created
◆ BASH     npm test                     running/complete/failed
```

- 路径尽量使用 Pi hyperlink 能力。
- 短命令单行显示；多行命令只展示第一行加省略标志。
- 不要把参数 JSON 整块倾倒到 transcript。

### read

默认展示一个清晰的状态/摘要行；因为用户设置了 `previewLines=0`，不要再自动塞尾部预览。expanded 时展示 hashline 内容：

```text
↳ loaded 48 lines • TypeScript • map
  20:a1f│ const value = ...
  21:b32│ ...
```

错误和 warning 使用现有 Sakura/error 色板。

### edit

默认保留当前用户偏好的展开 diff。重点优化视觉，而不是把信息藏起来：

- header 显示 `edited +N -M`、文件路径、semantic/warning/no-op 状态。
- diff 行使用稳定 gutter、old/new 区分、行号和适合窄终端的 unified 模式。
- 宽终端可使用左右 old/new，但必须在 80/100/120 列分别验证。
- 不要重复显示 readmap 已经在内容中表达的噪声。
- 大 diff 如果未来要折叠，必须保留明显的行数、`Ctrl+O` 提示，并且不能违背当前 `diffDisplay=expanded` 偏好。

### write

- `created`：摘要 + 行数/字节，expanded 显示内容 hashline 或带行号正文，不做全量 add diff。
- `overwritten`：摘要 + old/new diff。
- 二进制、warning、写入失败必须有明确状态。

### bash

- 简短输出直接展示。
- 较长输出显示行数、RTK/context guard 的真实提示和一小段 preview；expanded 显示当前 result 中实际可用的完整文本。
- 不要在 renderer 层执行第二次命令或读取 shell 原始 stdout。
- 不要让 `pi-jielumoon` 的 Sakura 外框和 Bash renderer 自己的外框叠两次。

## 8. 与 `message-borders.ts` 的交互风险

这是本任务最容易写成垃圾的地方。

现有 `message-borders.ts` 会对 Pi 的最终工具组件做 prototype patch。新 renderer 返回的 `Text`/`Container`/自定义 `Component` 会进入这条 patch 链。实现时必须验证：

1. `edit` 返回 `DiffPreviewComponent` 或新 diff component 后，外层 Sakura frame 仍只出现一次。
2. `write` 的新建内容和覆盖 diff 不被外层 `frameToolMessage` 错误识别成重复 border。
3. Bash 在 running、partial、complete、failed 四种状态下都能正常 repaint。
4. 图片 content 不被强行转成文本或包进普通 border。
5. `lastComponent` 和 `invalidate()` 正确复用/清理，避免流式结果残留旧 diff。
6. `/reload` 后 prototype patch 和 renderer patch 都是幂等的，没有越来越多的 wrapper。
7. `session_shutdown` / reload 后没有把别的扩展安装的 renderer 恢复掉。

如果新组件想直接自己画完整外框，必须先证明 `renderShell: "self"` 和当前 `message-borders` 兼容；默认不要这样做。

## 9. 测试与验证要求

### 纯单元测试

新增测试建议放在：

```text
tests/readmap-renderers.test.ts
```

测试重点：

- payload 缺失/格式错误时不抛异常。
- 同一工具重复 patch 不会叠加。
- `execute`、`parameters` 等非 renderer 属性保持原引用。
- `read` 成功、截断、symbol/map、error、无 `ptcValue` 都能渲染。
- `edit` 成功、空 diff、no-op、error、warning、semantic summary 都能渲染。
- `write` created/overwritten/binary/error 都能渲染。
- Bash 空输出、短输出、长输出、失败、partial 都能渲染。
- `ls` 路径参数、类型标记、空目录、截断、失败和折叠/展开都能渲染。
- 每个返回组件在 40、80、100、120 列下都不产生超宽行。
- `context.expanded=false/true` 的显示差异符合预期。
- ANSI 主题不存在或 theme 方法异常时有安全回退。

当前项目测试命令：

```bash
cd /home/jielumoon/opt/projects/pi-tui/pi-jielumoon
npm test
npm run typecheck
npm run pack:check
npm audit --omit=dev
```

`npm audit --omit=dev` 可能报告 Pi 0.83 core 上游的 `undici` / `brace-expansion` 公告；项目 AGENTS.md 已明确禁止用 `npm audit fix --force` 降级 Pi 来掩盖问题。不要把该已知审计背景误判成新 renderer 的失败。

### 真实 Pi TUI 验证

纯单测不够。至少需要：

1. 使用当前 readmap + 当前 pi-jielumoon 加载。
2. `read` 一个短 TS 文件和一个较长文件；执行一次 `ls` 检查目录条目。
3. 执行一行 edit、小范围多行 edit、大范围 edit、no-op/error。
4. `write` 新建文件和覆盖已有文件。
5. 执行普通短 Bash、带输出测试命令、失败命令。
6. 观察 80/100/120 列终端。
7. 使用 `Ctrl+O` 检查展开/折叠。
8. 执行 `/reload` 后重复以上至少一个场景。
9. 确认模型侧仍收到 readmap 原始 content/details，而不是为了 UI 被压缩或重写后的数据。

本地加载方式：

```bash
pi -e /home/jielumoon/opt/projects/pi-tui/pi-jielumoon
```

或者项目已安装时执行 `/reload`。不要在没有证据的情况下声称真实 TUI 已通过。

## 10. 不要做的事情

- 不 fork、复制或修改 readmap 源码。
- 不编辑 `~/.pi/agent/npm/node_modules/pi-hashline-readmap`。
- 不重新注册同名工具来“覆盖” readmap。
- 不为了 renderer 把 `@earendil-works/pi-coding-agent` 重复打包进 dependencies/bundledDependencies。
- 不引入第二套 diff 算法，除非已有 `diffData` 完全不能满足需求；优先使用 readmap 返回的结构化 diff。
- 不把 `tool_result` 事件当成 TUI renderer 接管的主要方案。
- 不用 `ctx.ui.custom()` 代替 transcript 中的 tool result renderer；那会变成另一个需要用户手动打开的 modal。
- 不默认启用激进 Bash 压缩；用户明确偏好更详细的普通 Bash 输出。
- 不因为视觉层改动去改 `LINE:HASH`、context hygiene 或 edit safety。
- 不把本地运行配置、令牌、账号或个人敏感信息写入仓库。

## 11. 推荐的实现顺序

1. 先读取并理解 `src/message-borders.ts`、`src/prototype-patch-registry.ts`、Pi `ToolDefinition` 类型。
2. 写一个只负责发现和 patch renderer 的小模块，先只处理 `read/edit/write`。
3. 为工具对象打 marker，加入 reload/重复加载保护。
4. 先实现纯 `Text` 版本，验证接管确实生效且执行层不变。
5. 再加入 diff component / 缓存 / 宽度适配。
6. 最后补 Bash：通过 `pi.getAllTools()` 找到 readmap wrapper，验证与 `BashExecutionComponent` patch 的关系。
7. 加单测，再跑真实 Pi TUI。
8. 只有在视觉效果确实满足后，才考虑把 renderer 拆成 `src/readmap/` 子目录；不要一开始过度设计成通用 renderer 框架。

## 12. 交付定义

下一位 Agent 完成后，至少应能回答并提供证据：

- 哪些文件被修改。
- readmap 的 `execute` 是否保持原样。
- renderer 是通过什么 hook 找到工具对象的。
- Bash 为什么能或不能通过同一个 hook 接管。
- 当前 `pi-tool-display` 配置是否仍保持冲突工具关闭。
- `npm test`、`npm run typecheck`、`npm run pack:check` 的真实结果。
- 真实 Pi TUI 中 `read/edit/write/bash/ls` 至少各一个成功场景和一个异常/边界场景截图或文字记录。
- `/reload` 后是否仍然只有一层 renderer/边框补丁。

## 13. 相关文件索引

### 当前项目

- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/AGENTS.md`
- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/README.md`
- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/package.json`
- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/src/index.ts`
- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/src/message-borders.ts`
- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/src/prototype-patch-registry.ts`
- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/tests/`

### 当前 readmap

- `/home/jielumoon/.pi/agent/npm/node_modules/pi-hashline-readmap/index.ts`
- `/home/jielumoon/.pi/agent/npm/node_modules/pi-hashline-readmap/src/read.ts`
- `/home/jielumoon/.pi/agent/npm/node_modules/pi-hashline-readmap/src/edit.ts`
- `/home/jielumoon/.pi/agent/npm/node_modules/pi-hashline-readmap/src/edit-output.ts`
- `/home/jielumoon/.pi/agent/npm/node_modules/pi-hashline-readmap/src/write.ts`
- `/home/jielumoon/.pi/agent/npm/node_modules/pi-hashline-readmap/src/bash-renderer.ts`
- `/home/jielumoon/.pi/agent/npm/node_modules/pi-hashline-readmap/src/tui-diff-component.ts`
- `/home/jielumoon/.pi/agent/npm/node_modules/pi-hashline-readmap/src/tui-render-utils.ts`

### Pi / 其他扩展

- `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- `/home/jielumoon/.pi/agent/npm/node_modules/pi-tool-display/src/tool-overrides.ts`
- `/home/jielumoon/.pi/agent/extensions/pi-tool-display/config.json`
- `/home/jielumoon/.pi/agent/hashline-readmap/settings.json`

## 14. 建议下一位 Agent 激活的技能

- `code-review-expert`：完成 renderer 后审查工具对象污染、生命周期、异常回退和潜在冲突。
- `ponytail-review`：专门检查是否引入了多余抽象、重复 diff 算法、无必要依赖或过度设计。
- 如果要查 Pi 官方 API，遵循项目环境中的 Pi 文档：
  - `/home/jielumoon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
  - `/home/jielumoon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/tui.md`
  - `/home/jielumoon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/tool-override.ts`
  - `/home/jielumoon/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/examples/extensions/todo.ts`
- 不需要创建单独的 Manus plan；用户已经明确表示当前不需要创建计划。直接在本项目内实现、测试和记录即可。

## 当前结论

这个需求技术上可行。最干净的边界是：

```text
pi-hashline-readmap  = 工具执行、安全锚点、结构化结果
pi-jielumoon        = readmap renderer + Sakura 视觉层
Pi                  = tool lifecycle、展开状态、最终 TUI
```

先用 `hashline:tool-executors` + `pi.getAllTools()` 做兼容性接入，保留 readmap 的执行函数和结果数据；再用当前项目已有的 tool-card/prototype patch 做统一外框。不要把这件事写成 readmap fork，也不要把它污染成第二个通用工具执行框架。
