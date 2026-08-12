import type { Component } from "@earendil-works/pi-tui";

/** 宿主 renderer 传入的调用上下文（Pi 0.83 实测字段的宽化视图）。 */
export type RenderContextLike = {
	args?: unknown;
	toolCallId?: string;
	invalidate?: () => void;
	lastComponent?: Component;
	state?: unknown;
	cwd?: string;
	executionStarted?: boolean;
	argsComplete?: boolean;
	isPartial?: boolean;
	expanded?: boolean;
	showImages?: boolean;
	isError?: boolean;
};

export type RenderOptionsLike = {
	expanded?: boolean;
	isPartial?: boolean;
};

export type ReadmapRendererSettings = {
	writeAnimation?: boolean;
	editAnimation?: boolean;
};

export const DEFAULT_READMAP_RENDERER_SETTINGS: ReadmapRendererSettings = {
	writeAnimation: true,
	editAnimation: true,
};

export type ToolPhase = "running" | "success" | "error" | "noop";

export type ToolResultLike = {
	content?: Array<{ type?: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
};
