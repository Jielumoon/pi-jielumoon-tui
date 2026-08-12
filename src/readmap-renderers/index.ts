/**
 * readmap 工具可视化接管的唯一入口。
 * 实现按职责拆分：presentation（净化/排版）、header（canonical 摘要）、
 * diff、stream-animation（逐字推进/调度）、write-stream / edit-stream（参数流预览）、
 * results（五个工具的内容渲染）、patch（安装）。
 */

import installReadmapRenderers from "./patch.ts";

export default installReadmapRenderers;
export { READMAP_RENDERER_MARK, TARGET_TOOL_NAMES, patchReadmapTool, patchToolPayload } from "./patch.ts";
export type { ReadmapRendererSettings } from "./types.ts";
export { DiffBodyComponent } from "./diff.ts";
export { WriteCallComponent } from "./write-stream.ts";
export { EditCallComponent, editStreamInput } from "./edit-stream.ts";
export { advanceStreamReveal, stopAllStreamAnimations } from "./stream-animation.ts";
export { clampLine, clampLines, normalizeWidth } from "./presentation.ts";
