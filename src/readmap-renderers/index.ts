/**
 * readmap 工具可视化接管的唯一入口。
 * 实现按职责拆分：presentation（净化/排版）、header（canonical 摘要）、
 * diff、write-stream（逐字动画）、results（五个工具的内容渲染）、patch（安装）。
 */

import installReadmapRenderers from "./patch.ts";

export default installReadmapRenderers;
export { READMAP_RENDERER_MARK, TARGET_TOOL_NAMES, patchReadmapTool, patchToolPayload } from "./patch.ts";
export type { ReadmapRendererSettings } from "./types.ts";
export { DiffBodyComponent } from "./diff.ts";
export { WriteCallComponent, advanceWriteReveal } from "./write-stream.ts";
export { clampLine, clampLines, normalizeWidth } from "./presentation.ts";
