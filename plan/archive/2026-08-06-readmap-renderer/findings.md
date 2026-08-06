# Findings & Decisions

## Requirements
- 在 `pi-jielumoon` 内写独立扩展模块，接管 readmap 工具 TUI 渲染
- 不 fork / 不修改 `pi-hashline-readmap` 源码或 `node_modules`
- 不重新实现 read/edit/write/bash 执行逻辑
- 不破坏 `LINE:HASH`、edit safety、context hygiene、RTK/bash 处理
- 只替换 `renderCall` / `renderResult`；模型侧 `content/details` 与 `execute` 保持原样
- 复用项目现有 Sakura / macaron 工具卡片风格
- 尊重用户配置：
  - `edit.diffDisplay = expanded`
  - `display.previewLines = 0`
- Bash：短输出尽量直接显示，不要过度压缩
- MVP 可验证即可，视觉可后调

## Research Findings

### 项目现状
- 入口：`src/index.ts` 顺序安装 nano-context / footer / thinking / message-borders / working / sakura-editor
- `message-borders.ts` 对 `ToolExecutionComponent` / `BashExecutionComponent` 做 prototype patch，给工具结果加 Sakura 外框
- 新 renderer 应只返回**内容组件**，不要 `renderShell: "self"`，避免双框
- 补丁幂等：`src/prototype-patch-registry.ts`（本任务 renderer patch 用 Symbol 标记工具对象即可，不必走 prototype registry）

### Pi 接口
- `ToolDefinition.renderCall(args, theme, context) => Component`
- `ToolDefinition.renderResult(result, options, theme, context) => Component`
- `ToolRenderContext` 含 args / toolCallId / lastComponent / state / cwd / executionStarted / argsComplete / isPartial / expanded / showImages / isError / invalidate
- 公开 `pi.getAllTools(): ToolInfo[]` 的 `ToolInfo` **不含** `definition` / `renderResult`，不能直接 patch
- 因此 handoff 里“靠 getAllTools 补 bash”在类型层面不成立，需要运行时再验证是否有隐藏字段；否则 Bash 需另找对象源

### readmap 0.11.2
- 路径：`~/.pi/agent/npm/node_modules/pi-hashline-readmap`
- 注册后：
  - `(globalThis as any).__hashlineToolExecutors = toolExecutors`
  - `pi.events.emit("hashline:tool-executors", toolExecutors)`
- event payload 含：read / edit / grep / ast_search / write / ls / find / 可选 nu / 可选 context_hygiene_report
- **bash 不在 toolExecutors**；由 `registerBashRendererTool()` 单独 register
- Bash wrapper：execute 委托原生 bash；render 用 result.content 文本

### 各工具结果形状（feature-detect，不 import 私有类型）
#### read
- `content[0].text` = hashline 文本
- `details.ptcValue.range.{startLine,endLine,totalLines}`
- `details.ptcValue.{truncation,symbol,map,warnings}`
- 当前 previewLines=0 → collapsed 只显示 summary

#### edit
- `details.diff` / `details.diffData` / `details.patch` / `details.firstChangedLine`
- `details.ptcValue.{ok,path,summary,warnings,noopEdits,semanticSummary,...}`
- expanded = `context.expanded || settings.edit.diffDisplay === "expanded"`
- 有 diffData 且 expanded 时用 DiffPreviewComponent

#### write
- `details.writeState`: `created` | `overwritten`
- `details.diffData` / `details.ptcValue.lines` / warnings
- created：展开显示内容，不做全量 add diff chrome
- overwritten：用 diffData

#### bash
- result.content text
- 失败首行 / expanded 全文
- 成功无输出：`command completed (no output)`
- 用户偏好：短输出直出

### DiffData 结构（本地 narrowing）
```ts
{
  version: 1,
  entries: Array<
    | { kind: "context"; oldLine: number; newLine: number; text: string }
    | { kind: "add"; newLine: number; text: string }
    | { kind: "remove"; oldLine: number; text: string }
    | { kind: "meta"; text: string }
  >,
  stats: { added: number; removed: number; context: number },
  language?: string,
  blockRanges?: ...,
  inlineDiffs?: ...,
}
```

### pi-tool-display
- 配置路径：`~/.pi/agent/extensions/pi-tool-display/config.json`
- read/grep/find/ls/bash/edit/write 的 `registerToolOverrides` 已为 false
- 不要重新打开这些开关；不要再 register 同名工具

### 用户配置
```json
// ~/.pi/agent/hashline-readmap/settings.json
{
  "edit": { "diffDisplay": "expanded" },
  "display": { "previewLines": 0 }
}
```

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| 文件：`src/readmap-renderers.ts` + index 注册 | handoff 推荐；MVP 不拆子目录 |
| 发现顺序：event → globalThis → session 扫描 | 兼容加载顺序；bash 单独兜底 |
| Bash 发现：扫描 global 注册表 / 可选拦截 registerTool | getAllTools 类型不够 |
| Symbol.for 标记 patched 工具 | reload 幂等 |
| 保留原 execute/parameters/description 引用 | 执行层不变的硬证据 |
| 自实现 DiffBodyComponent（unified/compact） | 不耦合 readmap 私有类；宽度在 render(width) 时计算 |
| theme.fg 失败回退纯文本 | 主题缺失不崩 |
| 测试用 mock tool 对象 | 不依赖真实 Pi session |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| handoff 写可用 getAllTools patch，但 ToolInfo 无 definition | 降级为 event/global 主路径；实现时再探 runtime 是否有隐藏 definition |
| bash 不在 hashline:tool-executors | 需要额外发现路径 |

## Resources
- handoff: `/home/jielumoon/opt/projects/pi-tui/pi-jielumoon/handoff/readmap-renderer.md`
- project: `src/index.ts`, `src/message-borders.ts`, `src/prototype-patch-registry.ts`
- readmap: `~/.pi/agent/npm/node_modules/pi-hashline-readmap/{index.ts,src/read.ts,edit.ts,write.ts,bash-renderer.ts,diff-data.ts,tui-diff-component.ts,tui-diff-renderer.ts,tui-render-utils.ts}`
- Pi types: `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- pi-tool-display: `~/.pi/agent/npm/node_modules/pi-tool-display/src/tool-overrides.ts`
- settings: `~/.pi/agent/hashline-readmap/settings.json`
- docs: `~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`

## Visual/Browser Findings
- 暂无真实 TUI 截图；实现后手动 `pi -e ...` 验证

## Implementation Sketch（Phase 3 执行蓝图）

```text
src/readmap-renderers.ts
  installReadmapRenderers(pi)
    ├─ on("hashline:tool-executors") → patchPayload
    ├─ boot: patch globalThis.__hashlineToolExecutors
    ├─ on session_start / before_agent_start → rescan
    └─ optional: wrap pi.registerTool 仅观察 bash 对象（若 API 允许且可清理）

  patchTool(tool)
    ├─ name in {read,edit,write,bash}
    ├─ already marked → skip
    ├─ save original renderers for fallback
    └─ replace renderCall / renderResult only

  renderers
    read:  title path:range · summary badges · expanded hashlines
    edit:  path · edits · +N -M · expanded DiffBody
    write: path · created/overwritten · content or DiffBody
    bash:  command · short full / long preview · expanded full
```

### MVP 视觉
```text
◆ READ     src/foo.ts:20-48       symbol: bar
↳ loaded 48 lines • map

◆ EDIT     src/foo.ts             3 edits
↳ edited +12 -4
  ▌- 20 │ old
  ▌+ 20 │ new

◆ WRITE    src/new.ts             42 lines · created
↳ created

◆ BASH     npm test
↳ 18 lines returned
  ...output...
```

### 安全策略
- details 缺失 → 纯文本 fallback
- renderer throw → catch 后原 renderer 或 Text
- 每行 `visibleWidth` / `truncateToWidth` / hanging wrap
- 不修改 result content
- 不设 renderShell self
