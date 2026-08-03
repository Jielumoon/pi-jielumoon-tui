import {
	BashExecutionComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	renderBoxedLine,
	renderSakuraFrameGradient,
	renderSakuraSolid,
	rgbForeground,
} from "./gradient";
import { installPrototypePatch } from "./prototype-patch-registry";

type Cleanup = () => void;
type RenderedLines = string[];

type ToolRuntime = {
	isPartial?: boolean;
	result?: {
		isError?: boolean;
		content?: Array<{ type?: string }>;
	};
	toolName?: string;
	hideComponent?: boolean;
	expanded?: boolean;
	showImages?: boolean;
};

type PatchableUserMessage = {
	text?: string;
};

type UserMessageRenderCache = {
	text: string;
	width: number;
	theme: Theme | undefined;
	lines: RenderedLines;
};

type ToolRenderCache = {
	width: number;
	result: ToolRuntime["result"];
	expanded: boolean;
	showImages: boolean;
	lines: RenderedLines;
};

const userMessageRenderCache = new WeakMap<object, UserMessageRenderCache>();
const toolRenderCache = new WeakMap<object, ToolRenderCache>();

const MIN_BORDER_WIDTH = 8;
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const RAIL_WORKING = [159, 211, 242] as const;
const RAIL_SUCCESS = [174, 229, 197] as const;
const RAIL_ERROR = [255, 143, 163] as const;

function isRenderedLines(value: unknown): value is RenderedLines {
	return Array.isArray(value) && value.every((line) => typeof line === "string");
}

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

function stripAnsi(line: string): string {
	return line
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isBlank(line: string): boolean {
	return stripAnsi(line).trim().length === 0;
}

function containsTerminalImage(lines: readonly string[]): boolean {
	return lines.some((line) => line.includes("\x1b_G") || line.includes("\x1b]1337;File="));
}

function containsResultImage(runtime: ToolRuntime): boolean {
	return runtime.result?.content?.some((item) => item.type === "image") ?? false;
}

function fitInnerLine(line: string, width: number): string {
	const content = truncateToWidth(line, width, "");
	return `${content}${" ".repeat(Math.max(0, width - visibleWidth(content)))}`;
}

function themeFg(theme: Theme | undefined, color: ThemeColor, text: string): string {
	if (!theme) return text;
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

function makeUserMarkdownTheme(theme: Theme | undefined): MarkdownTheme {
	return {
		heading: (text) => themeFg(theme, "mdHeading", text),
		link: (text) => themeFg(theme, "mdLink", text),
		linkUrl: (text) => themeFg(theme, "mdLinkUrl", text),
		code: (text) => themeFg(theme, "mdCode", text),
		codeBlock: (text) => themeFg(theme, "mdCodeBlock", text),
		codeBlockBorder: (text) => themeFg(theme, "mdCodeBlockBorder", text),
		quote: (text) => themeFg(theme, "mdQuote", text),
		quoteBorder: (text) => themeFg(theme, "mdQuoteBorder", text),
		hr: (text) => themeFg(theme, "mdHr", text),
		listBullet: (text) => themeFg(theme, "mdListBullet", text),
		bold: (text) => (theme ? theme.bold(text) : text),
		italic: (text) => (theme ? theme.italic(text) : text),
		underline: (text) => (theme ? theme.underline(text) : text),
		strikethrough: (text) => (theme ? theme.strikethrough(text) : text),
	};
}

function renderUserLine(line: string, width: number): string {
	const rail = `${renderSakuraSolid("▐")} `;
	const contentWidth = Math.max(0, width - visibleWidth(rail));
	return truncateToWidth(`${rail}${fitInnerLine(line, contentWidth)}`, width, "");
}

function withPromptZoneMarkers(lines: RenderedLines): RenderedLines {
	const markedLines = [...lines];
	markedLines[0] = OSC133_ZONE_START + markedLines[0];
	markedLines[markedLines.length - 1] =
		OSC133_ZONE_END + OSC133_ZONE_FINAL + markedLines[markedLines.length - 1];
	return markedLines;
}

/** 复用 Sakura 用户消息的 Markdown + 渐变 rail 结构，不使用 Pi 默认 Box。 */
function renderSakuraUserMessage(
	receiver: PatchableUserMessage,
	width: number,
	theme: Theme | undefined,
): RenderedLines | undefined {
	const text = receiver.text;
	if (typeof text !== "string" || width < MIN_BORDER_WIDTH) return undefined;

	const cached = userMessageRenderCache.get(receiver as object);
	if (cached?.text === text && cached.width === width && cached.theme === theme) return cached.lines;

	const rail = `${renderSakuraSolid("▐")} `;
	const contentWidth = Math.max(1, width - visibleWidth(rail));
	const renderer = new Markdown(
		text,
		0,
		0,
		makeUserMarkdownTheme(theme),
		{ color: (content) => themeFg(theme, "userMessageText", content) },
	);
	const rendered = renderer.render(contentWidth);
	const contentLines = rendered.length > 0 ? rendered : [""];
	const border = renderSakuraFrameGradient("─".repeat(width));
	const lines = [
		border,
		renderUserLine("", width),
		...contentLines.map((line) => renderUserLine(line, width)),
		renderUserLine("", width),
		border,
	];
	const markedLines = withPromptZoneMarkers(lines);
	userMessageRenderCache.set(receiver as object, { text, width, theme, lines: markedLines });
	return markedLines;
}

function toolName(runtime: ToolRuntime): string {
	return (runtime.toolName || "tool").replaceAll("_", " ").toUpperCase();
}

function toolStatusLabel(runtime: ToolRuntime, running: boolean): string {
	const name = toolName(runtime);
	if (running) return `◆ ${name} · RUNNING`;
	return runtime.result?.isError ? `× ${name} · FAILED` : `✓ ${name} · COMPLETE`;
}

function fitBorderLabel(label: string, width: number): string {
	if (width <= 0) return "";
	if (width === 1) return "╭";
	const innerWidth = Math.max(0, width - 2);
	const lead = `─ ${label} `;
	let result = "";
	let used = 0;
	for (const char of lead) {
		const charWidth = visibleWidth(char);
		if (used + charWidth > innerWidth) break;
		result += char;
		used += charWidth;
	}
	return `╭${result}${"─".repeat(Math.max(0, innerWidth - used))}╮`;
}

function bottomBorder(width: number): string {
	if (width <= 0) return "";
	if (width === 1) return "╰";
	return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

function toolLeftRail(runtime: ToolRuntime): string {
	if (runtime.isPartial !== false) return rgbForeground(RAIL_WORKING, "┃ ");
	if (runtime.result?.isError) return rgbForeground(RAIL_ERROR, "┃ ");
	return rgbForeground(RAIL_SUCCESS, "┃ ");
}

function isHorizontalBorder(line: string): boolean {
	const plain = stripAnsi(line).trim();
	return /^[─═]{3,}$/.test(plain) || /^[╭┌╔].*[╮┐╗]$/.test(plain) || /^[╰└╚].*[╯┘╝]$/.test(plain);
}

function frameToolMessage(lines: RenderedLines, width: number, runtime: ToolRuntime): RenderedLines {
	if (
		width <= 2 ||
		lines.length === 0 ||
		runtime.hideComponent ||
		containsTerminalImage(lines) ||
		containsResultImage(runtime)
	) {
		return lines;
	}

	const body = [...lines];
	const prefix: string[] = [];
	if (body[0] !== undefined && isBlank(body[0])) {
		prefix.push(body.shift()!);
	}
	if (body[0] !== undefined && isHorizontalBorder(body[0])) body.shift();
	if (body.at(-1) !== undefined && isHorizontalBorder(body.at(-1)!)) body.pop();

	const running = runtime.isPartial !== false;
	const label = fitBorderLabel(toolStatusLabel(runtime, running), width);
	const leftRail = toolLeftRail(runtime);
	const rightRail = renderSakuraSolid("│");
	const top = truncateToWidth(renderSakuraFrameGradient(label), width, "");
	const bottom = truncateToWidth(renderSakuraFrameGradient(bottomBorder(width)), width, "");
	return [
		...prefix,
		top,
		...body.map((line) => renderBoxedLine(line, width, leftRail, rightRail)),
		bottom,
	];
}

function repaintBashBorders(lines: RenderedLines, width: number): RenderedLines {
	if (width <= 2 || lines.length === 0 || containsTerminalImage(lines)) return lines;

	const plainLines = lines.map(stripAnsi);
	const running = plainLines.some((line) => line.includes("Running..."));
	const failed = plainLines.some((line) => /\(exit \d+\)/.test(line));
	const label = running
		? "◆ BASH · RUNNING"
		: failed
			? "× BASH · FAILED"
			: "✓ BASH · COMPLETE";
	let topPainted = false;

	return lines.map((line, index) => {
		const plain = plainLines[index]?.trim() ?? "";
		const horizontal = /^[─═]{3,}$/.test(plain);
		const topShape = /^[╭┌╔].*[╮┐╗]$/.test(plain);
		const bottomShape = /^[╰└╚].*[╯┘╝]$/.test(plain);
		if (bottomShape) return renderSakuraFrameGradient(bottomBorder(width));
		if (topShape || horizontal) {
			if (!topPainted) {
				topPainted = true;
				return renderSakuraFrameGradient(fitBorderLabel(label, width));
			}
			return renderSakuraFrameGradient(bottomBorder(width));
		}
		return line;
	});
}

export function installMessageBorders(getTheme: () => Theme | undefined): Cleanup {
	const cleanupUserMessage = installPrototypePatch(
		UserMessageComponent.prototype,
		"render",
		"user-message-render",
		({ predecessor, receiver, args }) => {
			const width = args[0];
			if (typeof width !== "number") return Reflect.apply(predecessor, receiver, args);
			const rendered = renderSakuraUserMessage(receiver as PatchableUserMessage, width, getTheme());
			return rendered ?? Reflect.apply(predecessor, receiver, args);
		},
	);

	const cleanupUserInvalidate = installPrototypePatch(
		UserMessageComponent.prototype,
		"invalidate",
		"user-message-invalidate",
		({ predecessor, receiver, args }) => {
			if (isObject(receiver)) userMessageRenderCache.delete(receiver);
			return Reflect.apply(predecessor, receiver, args);
		},
	);

	const cleanupToolMessage = installPrototypePatch(
		ToolExecutionComponent.prototype,
		"render",
		"tool-execution-render",
		({ predecessor, receiver, args }) => {
			const runtime = receiver as ToolRuntime;
			const width = args[0];
			if (
				typeof width === "number" &&
				isObject(receiver) &&
				runtime.isPartial === false &&
				!runtime.hideComponent &&
				!containsResultImage(runtime)
			) {
				const cached = toolRenderCache.get(receiver);
				if (
					cached?.width === width &&
					cached.result === runtime.result &&
					cached.expanded === Boolean(runtime.expanded) &&
					cached.showImages === Boolean(runtime.showImages)
				) {
					return cached.lines;
				}
			}

			const rendered = Reflect.apply(predecessor, receiver, args);
			if (!isRenderedLines(rendered) || typeof width !== "number") return rendered;
			const framed = frameToolMessage(rendered, width, runtime);
			if (
				isObject(receiver) &&
				runtime.isPartial === false &&
				!runtime.hideComponent &&
				!containsResultImage(runtime)
			) {
				toolRenderCache.set(receiver, {
					width,
					result: runtime.result,
					expanded: Boolean(runtime.expanded),
					showImages: Boolean(runtime.showImages),
					lines: framed,
				});
			}
			return framed;
		},
	);

	const cleanupToolInvalidate = installPrototypePatch(
		ToolExecutionComponent.prototype,
		"invalidate",
		"tool-execution-invalidate",
		({ predecessor, receiver, args }) => {
			if (isObject(receiver)) toolRenderCache.delete(receiver);
			return Reflect.apply(predecessor, receiver, args);
		},
	);

	const cleanupBashMessage = installPrototypePatch(
		BashExecutionComponent.prototype,
		"render",
		"bash-execution-render",
		({ predecessor, receiver, args }) => {
			const rendered = Reflect.apply(predecessor, receiver, args);
			const width = args[0];
			if (!isRenderedLines(rendered) || typeof width !== "number") return rendered;
			return repaintBashBorders(rendered, width);
		},
	);

	let cleaned = false;
	return () => {
		if (cleaned) return;
		cleaned = true;
		cleanupBashMessage();
		cleanupToolInvalidate();
		cleanupToolMessage();
		cleanupUserInvalidate();
		cleanupUserMessage();
	};
}

export default function jielumoonMessageBorders(pi: ExtensionAPI): void {
	let cleanup: Cleanup | undefined;
	let activeTheme: Theme | undefined;

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui" || cleanup) return;
		activeTheme = ctx.ui.theme;
		cleanup = installMessageBorders(() => activeTheme);
	});

	pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		cleanup?.();
		cleanup = undefined;
		activeTheme = undefined;
	});
}
