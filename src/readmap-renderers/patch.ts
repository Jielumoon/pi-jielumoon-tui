/**
 * readmap 工具的 renderer 接管：hashline 事件 / globalThis / registerTool 三条路径。
 * 只替换 renderCall/renderResult；execute 与参数 schema 保持原引用。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { isObjectLike as isObject } from "../guards.ts";
import { asThemeLike } from "./presentation.ts";
import {
	renderBashResult,
	renderEditResult,
	renderLsResult,
	renderReadResult,
	renderToolCall,
	renderWriteResult,
} from "./results.ts";
import {
	DEFAULT_READMAP_RENDERER_SETTINGS,
	type ReadmapRendererSettings,
	type RenderContextLike,
	type ToolResultLike,
} from "./types.ts";
import { stopAllWriteAnimations } from "./write-stream.ts";

/** 本扩展已接管的工具对象标记，保证 reload 幂等。 */
export const READMAP_RENDERER_MARK = Symbol.for("pi-jielumoon.readmap-renderer");

/** 接管 readmap 的常用文件/命令工具；其余 readmap 工具保持原 renderer。 */
export const TARGET_TOOL_NAMES = new Set(["read", "edit", "write", "bash", "ls"]);

const readmapRendererSettings = new WeakMap<object, ReadmapRendererSettings>();

type PatchableTool = {
	name?: string;
	renderCall?: (...args: never[]) => unknown;
	renderResult?: (...args: never[]) => unknown;
	execute?: (...args: never[]) => unknown;
	renderShell?: "default" | "self";
	parameters?: unknown;
	description?: unknown;
	[key: string]: unknown;
};

type OriginalRenderers = {
	renderCall?: PatchableTool["renderCall"];
	renderResult?: PatchableTool["renderResult"];
};

type GlobalWithHashline = typeof globalThis & {
	__hashlineToolExecutors?: Record<string, unknown>;
};

const REGISTER_TOOL_INTERCEPTOR = Symbol.for("pi-jielumoon.readmap-registerTool");

type PiWithRegisterInterceptor = ExtensionAPI & {
	[REGISTER_TOOL_INTERCEPTOR]?: {
		wrapped: ExtensionAPI["registerTool"];
		settings: ReadmapRendererSettings;
	};
};

function toolNameOf(tool: PatchableTool): string | undefined {
	return typeof tool.name === "string" ? tool.name : undefined;
}

function safeCallOriginal(
	original: OriginalRenderers["renderCall"] | OriginalRenderers["renderResult"],
	args: unknown[],
): Component | undefined {
	if (typeof original !== "function") return undefined;
	try {
		const result = (original as (...a: unknown[]) => unknown)(...args);
		if (result && typeof (result as Component).render === "function") {
			return result as Component;
		}
	} catch {
		// fall through
	}
	return undefined;
}

/** 原地替换目标工具的 renderer；返回是否完成 patch。 */
export function patchReadmapTool(
	tool: unknown,
	settings: ReadmapRendererSettings = DEFAULT_READMAP_RENDERER_SETTINGS,
): boolean {
	if (!isObject(tool)) return false;
	const target = tool as PatchableTool;
	const name = toolNameOf(target);
	if (!name || !TARGET_TOOL_NAMES.has(name)) return false;
	readmapRendererSettings.set(target, settings);
	if (READMAP_RENDERER_MARK in target && target[READMAP_RENDERER_MARK] === true) {
		return false;
	}

	const originals: OriginalRenderers = {
		renderCall: target.renderCall,
		renderResult: target.renderResult,
	};

	const renderCall = (args: unknown, theme: unknown, context: RenderContextLike = {}) => {
		const t = asThemeLike(theme);
		try {
			return renderToolCall(
				name,
				args,
				t,
				context,
				readmapRendererSettings.get(target) ?? DEFAULT_READMAP_RENDERER_SETTINGS,
			);
		} catch {
			return (
				safeCallOriginal(originals.renderCall, [args, theme, context])
				?? new Text(String(name), 0, 0)
			);
		}
	};

	const renderResult = (
		result: ToolResultLike,
		options: { expanded?: boolean; isPartial?: boolean } = {},
		theme: unknown = {},
		context: RenderContextLike = {},
	) => {
		const t = asThemeLike(theme);
		try {
			switch (name) {
				case "read":
					return renderReadResult(result, options, t, context);
				case "edit":
					return renderEditResult(result, options, t, context);
				case "write":
					return renderWriteResult(result, options, t, context);
				case "bash":
					return renderBashResult(result, options, t, context);

				case "ls":
					return renderLsResult(result, options, t, context);
			}
		} catch {
			return (
				safeCallOriginal(originals.renderResult, [result, options, theme, context])
				?? new Text("· render error", 0, 0)
			);
		}
	};

	target.renderCall = renderCall as PatchableTool["renderCall"];
	target.renderResult = renderResult as PatchableTool["renderResult"];
	target.renderShell = "self";
	Object.defineProperty(target, READMAP_RENDERER_MARK, {
		value: true,
		configurable: true,
		enumerable: false,
		writable: false,
	});
	return true;
}

/**
 * 扫描 event / global payload 中的工具对象。
 * 注意：工具对象缺少 `name` 时会以 payload key 回填并写回原对象。
 */
export function patchToolPayload(
	payload: unknown,
	settings: ReadmapRendererSettings = DEFAULT_READMAP_RENDERER_SETTINGS,
): string[] {
	const patched: string[] = [];
	if (!payload || typeof payload !== "object") return patched;
	for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
		const tool = value as PatchableTool;
		const name = typeof tool?.name === "string" ? tool.name : key;
		if (!TARGET_TOOL_NAMES.has(name)) continue;
		if (isObject(tool) && typeof tool.name !== "string") {
			// payload key is authoritative when tool.name missing
			(tool as PatchableTool).name = name;
		}
		if (patchReadmapTool(tool, settings)) patched.push(name);
	}
	return patched;
}

function patchGlobalExecutors(settings: ReadmapRendererSettings): string[] {
	const global = globalThis as GlobalWithHashline;
	return patchToolPayload(global.__hashlineToolExecutors, settings);
}

/** 观察后续 registerTool（含 bash）；幂等，扩展生命周期内保持。 */
function installRegisterToolObserver(pi: ExtensionAPI, settings: ReadmapRendererSettings): void {
	const tagged = pi as PiWithRegisterInterceptor;
	const existing = tagged[REGISTER_TOOL_INTERCEPTOR];
	if (existing?.wrapped === pi.registerTool) {
		existing.settings = settings;
		return;
	}

	// 始终包当前函数：其它扩展重载后再 /reload，不会跳过新拦截器。
	const original = pi.registerTool.bind(pi);
	const interceptor = { settings, wrapped: undefined as unknown as ExtensionAPI["registerTool"] };
	const wrapped: ExtensionAPI["registerTool"] = ((tool) => {
		original(tool);
		try {
			patchReadmapTool(tool, interceptor.settings);
		} catch {
			// renderer patch 失败不能影响工具注册
		}
	}) as ExtensionAPI["registerTool"];
	interceptor.wrapped = wrapped;
	pi.registerTool = wrapped;
	tagged[REGISTER_TOOL_INTERCEPTOR] = interceptor;
}

/**
 * 安装 readmap 工具可视化接管。
 * event/global 路径可靠覆盖 read/edit/write；bash 仅在本扩展先于它注册时可接管。
 * 只替换 renderCall/renderResult；execute 与参数 schema 保持原引用。
 */
export default function installReadmapRenderers(
	pi: ExtensionAPI,
	settings: ReadmapRendererSettings = DEFAULT_READMAP_RENDERER_SETTINGS,
): void {
	const boot = () => {
		try {
			patchGlobalExecutors(settings);
		} catch {
			// quiet degrade
		}
	};

	try {
		pi.events.on("hashline:tool-executors", (payload) => {
			try {
				patchToolPayload(payload, settings);
			} catch {
				// quiet degrade
			}
		});
	} catch {
		// events bus unavailable
	}

	try {
		installRegisterToolObserver(pi, settings);
	} catch {
		// registerTool not writable
	}

	boot();
	pi.on("session_start", boot);
	pi.on("before_agent_start", boot);
	pi.on("session_shutdown", stopAllWriteAnimations);
}
