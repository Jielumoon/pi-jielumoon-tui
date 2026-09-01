/**
 * 工具 renderer 接管：readmap 重定义工具走 hashline 事件 / globalThis / registerTool 三条路径，
 * pi 原生与第三方注册的全部目标工具（含 read/edit/write/grep/find/apply_patch）走
 * ToolExecutionComponent 组件桥接兜底。只替换 renderCall/renderResult；execute 与参数 schema 保持原引用。
 */

import { ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { isObjectLike as isObject } from "../guards.ts";
import { installPrototypePatch } from "../prototype-patch-registry.ts";
import { asThemeLike } from "./presentation.ts";
import {
	renderApplyPatchResult,
	renderBashResult,
	renderEditResult,
	renderFindResult,
	renderGrepResult,
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
import { stopAllStreamAnimations } from "./stream-animation.ts";

/** 本扩展已接管的工具对象标记，保证 reload 幂等。 */
export const READMAP_RENDERER_MARK = Symbol.for("pi-jielumoon.readmap-renderer");

/**
 * 接管的工具集合：read/edit/write/bash/ls（readmap 或 pi 原生）、grep/find（pi 核心）、
 * apply_patch（第三方 @xl0/pi-lovely-codex）。readmap 注册路径只覆盖扩展重定义的工具，
 * pi 原生与第三方注册的工具靠组件桥接兜底，全部名字共用这一个集合。
 */
export const TARGET_TOOL_NAMES = new Set([
	"read", "edit", "write", "bash", "ls", "grep", "find", "apply_patch",
]);

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
				case "grep":
					return renderGrepResult(result, options, t, context);
				case "find":
					return renderFindResult(result, options, t, context);
				case "apply_patch":
					return renderApplyPatchResult(result, options, t, context);
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

type ToolComponentLike = {
	toolName?: unknown;
	toolDefinition?: unknown;
	builtInToolDefinition?: unknown;
};

let componentBridgeInstalled = false;

/**
 * 组件桥接是所有目标工具的兜底网：readmap 注册路径（hashline/global/registerTool）
 * 只能看到扩展重定义的工具；pi 原生的 read/edit/write/grep/find 与第三方注册的
 * apply_patch 都不经这些路径。桥接点选在 ToolExecutionComponent.getRenderShell：
 * 它在构造器里先于首次 updateDisplay 被调用，此刻就地 patch 该组件引用的工具定义对象
 * （优先 toolDefinition——session 注册表的共享对象，跨组件持久；builtIn 副本仅作兜底），
 * 同一渲染周期内 renderShell/renderCall/renderResult 即全部生效。
 * 与 registerTool 拦截器同为幂等安装（READMAP_RENDERER_MARK 防重复 patch）；
 * /reload 时注册表重建新对象，桥接重新生效。
 */
function installComponentRendererBridge(settings: ReadmapRendererSettings): void {
	if (componentBridgeInstalled) return;
	installPrototypePatch(
		ToolExecutionComponent.prototype,
		"getRenderShell",
		"tool-execution-render-shell",
		({ predecessor, receiver, args }) => {
			const component = receiver as ToolComponentLike;
			const name = typeof component.toolName === "string" ? component.toolName : undefined;
			if (name !== undefined && TARGET_TOOL_NAMES.has(name)) {
				try {
					patchReadmapTool(component.toolDefinition ?? component.builtInToolDefinition, settings);
				} catch {
					// renderer 桥接失败不能影响宿主渲染
				}
			}
			return Reflect.apply(predecessor, receiver, args);
		},
	);
	componentBridgeInstalled = true;
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
 * 安装 readmap 工具可视化接管：readmap 注册路径覆盖扩展重定义的工具，
 * 组件桥接兜底 pi 原生与第三方注册的工具（read/edit/write/grep/find/apply_patch…）。
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

	try {
		installComponentRendererBridge(settings);
	} catch {
		// 组件原型不可写时静默降级：grep/find/apply_patch 保持宿主原生渲染
	}

	boot();
	pi.on("session_start", boot);
	pi.on("before_agent_start", boot);
	pi.on("session_shutdown", stopAllStreamAnimations);
}
