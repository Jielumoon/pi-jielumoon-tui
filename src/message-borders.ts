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
	renderSakuraSpinner,
	renderSakuraSolid,
	rgbForeground,
} from "./gradient";
import { installPrototypePatch } from "./prototype-patch-registry";
import { resolveRenderMode } from "./render-mode";

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
	revision: number;
	width: number;
	result: ToolRuntime["result"];
	expanded: boolean;
	showImages: boolean;
	lines: RenderedLines;
};

type BashRuntime = {
	status?: "running" | "complete" | "cancelled" | "error";
	command?: string;
	exitCode?: number;
	outputLines?: readonly string[];
	expanded?: boolean;
};

type BashRenderCache = {
	width: number;
	outputLines: readonly string[] | undefined;
	outputLength: number;
	lastOutputLine: string | undefined;
	status: BashRuntime["status"];
	expanded: boolean;
	lines: RenderedLines;
};

const userMessageRenderCache = new WeakMap<object, UserMessageRenderCache>();
const toolRenderCache = new WeakMap<object, ToolRenderCache>();
const toolRenderRevision = new WeakMap<object, number>();
const bashRenderCache = new WeakMap<object, BashRenderCache>();

const MIN_RAIL_WIDTH = 7;
const READ_INDENT_WIDTH = 2;
const TOOL_FRAME_CHROME_WIDTH = 3;
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const RAIL_WORKING = [159, 211, 242] as const;
const RAIL_SUCCESS = [174, 229, 197] as const;
const RAIL_ERROR = [255, 143, 163] as const;
const RAIL_CANCELLED = [243, 217, 139] as const;
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


const TRAILING_TERMINAL_PADDING = /[ \t]+((?:(?:\x1b\[[0-?]*[ -/]*[@-~])|(?:\x1b\][^\x07]*(?:\x07|\x1b\\)))*)$/;

/** 移除 Text 为整行补齐的尾空格，同时保留其后的 ANSI reset。 */
function trimTerminalPadding(line: string): string {
	let trimmed = line;
	while (true) {
		const next = trimmed.replace(TRAILING_TERMINAL_PADDING, "$1");
		if (next === trimmed) return trimmed;
		trimmed = next;
	}
}

/** 移除宿主工具卡背景，保留前景色、粗体及其它 SGR 样式。 */
function stripBackgroundAnsi(line: string): string {
	return line.replace(/\x1b\[([0-9;:]*)m/g, (_sequence, parameters: string) => {
		const values = parameters.split(";");
		const kept: string[] = [];
		for (let index = 0; index < values.length; index += 1) {
			const value = values[index] ?? "";
			if (value.startsWith("48:") || value === "49") continue;
			const code = Number(value || "0");
			if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) continue;
			if (code === 48) {
				const mode = values[index + 1];
				index += mode === "2" ? 4 : mode === "5" ? 2 : 0;
				continue;
			}
			kept.push(value);
		}
		return kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
	});
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

function toolPredecessorWidth(width: number, runtime: ToolRuntime): number {
	if (
		resolveRenderMode() !== "color" ||
		!Number.isFinite(width) ||
		width <= 2 ||
		runtime.hideComponent ||
		(runtime.toolName !== "read" && containsResultImage(runtime))
	) {
		return width;
	}
	const chromeWidth = runtime.toolName === "read" ? READ_INDENT_WIDTH : TOOL_FRAME_CHROME_WIDTH;
	return Math.max(1, Math.floor(width) - chromeWidth);
}

function bashPredecessorWidth(width: number, runtime: BashRuntime): number {
	if (
		resolveRenderMode() !== "color" ||
		!Number.isFinite(width) ||
		width <= 2 ||
		containsTerminalImage(runtime.outputLines ?? [])
	) {
		return width;
	}
	return Math.max(1, Math.floor(width) - TOOL_FRAME_CHROME_WIDTH);
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
	const outerRail = renderSakuraSolid("│");
	return renderBoxedLine(line, width, `${outerRail} ${renderSakuraSolid("▌")} `, outerRail);
}

function withPromptZoneMarkers(lines: RenderedLines): RenderedLines {
	const markedLines = [...lines];
	markedLines[0] = OSC133_ZONE_START + markedLines[0];
	markedLines[markedLines.length - 1] =
		OSC133_ZONE_END + OSC133_ZONE_FINAL + markedLines[markedLines.length - 1];
	return markedLines;
}

/** 复用 Pi Markdown，以无标题圆框和 Sakura 粗 rail 区分用户消息。 */
function renderSakuraUserMessage(
	receiver: PatchableUserMessage,
	width: number,
	theme: Theme | undefined,
): RenderedLines | undefined {
	const text = receiver.text;
	if (resolveRenderMode() !== "color" || typeof text !== "string" || width < MIN_RAIL_WIDTH) return undefined;

	const cached = userMessageRenderCache.get(receiver as object);
	if (cached?.text === text && cached.width === width && cached.theme === theme) return cached.lines;

	const outerRail = renderSakuraSolid("│");
	const leftRail = `${outerRail} ${renderSakuraSolid("▌")} `;
	const rightRail = outerRail;
	const contentWidth = Math.max(1, width - visibleWidth(leftRail) - visibleWidth(rightRail));
	const renderer = new Markdown(
		text,
		0,
		0,
		makeUserMarkdownTheme(theme),
		{ color: (content) => themeFg(theme, "userMessageText", content) },
	);
	const rendered = renderer.render(contentWidth);
	const contentLines = rendered.length > 0 ? rendered : [""];
	const lines = [
		truncateToWidth(renderSakuraFrameGradient(topBorder(width)), width, ""),
		...contentLines.map((line) => renderUserLine(line, width)),
		truncateToWidth(renderSakuraFrameGradient(bottomBorder(width)), width, ""),
	];
	const markedLines = withPromptZoneMarkers(lines);
	userMessageRenderCache.set(receiver as object, { text, width, theme, lines: markedLines });
	return markedLines;
}

function toolState(runtime: ToolRuntime): "running" | "success" | "error" {
	if (runtime.isPartial !== false) return "running";
	return runtime.result?.isError ? "error" : "success";
}

function stateMarker(state: "running" | "success" | "error" | "cancelled"): string {
	if (state === "running") return renderSakuraSpinner();
	if (state === "error") return rgbForeground(RAIL_ERROR, "×");
	if (state === "cancelled") return rgbForeground(RAIL_CANCELLED, "!");
	return rgbForeground(RAIL_SUCCESS, "✓");
}

function topBorder(width: number): string {
	if (width <= 0) return "";
	if (width === 1) return "╭";
	return `╭${"─".repeat(Math.max(0, width - 2))}╮`;
}

function titleBorder(title: string, width: number): string {
	const semanticTitle = trimTerminalPadding(title);
	if (width < 8 || isBlank(semanticTitle)) {
		return truncateToWidth(renderSakuraFrameGradient(topBorder(width)), width, "");
	}
	const left = "╭─ ";
	const minimumRight = " ─╮";
	const titleWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(minimumRight));
	const fittedTitle = truncateToWidth(semanticTitle, titleWidth, "…");
	const fillWidth = Math.max(1, width - visibleWidth(left) - visibleWidth(fittedTitle) - visibleWidth(" ╮"));
	return `${renderSakuraFrameGradient(left)}${fittedTitle}${renderSakuraFrameGradient(` ${"─".repeat(fillWidth)}╮`)}`;
}

function bottomBorder(width: number): string {
	if (width <= 0) return "";
	if (width === 1) return "╰";
	return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

function stateRail(state: "running" | "success" | "error" | "cancelled"): string {
	if (state === "running") return rgbForeground(RAIL_WORKING, "┃ ");
	if (state === "error") return rgbForeground(RAIL_ERROR, "┃ ");
	if (state === "cancelled") return rgbForeground(RAIL_CANCELLED, "┃ ");
	return rgbForeground(RAIL_SUCCESS, "┃ ");
}

const LEADING_STATE_MARKER = /^(?:\x1b\[[0-?]*[ -/]*[@-~])*[◇✓×!·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?:\x1b\[[0-?]*[ -/]*[@-~])*\s+/;

function replaceStateMarker(line: string, state: "running" | "success" | "error"): string {
	const content = line.trimStart();
	return LEADING_STATE_MARKER.test(content)
		? content.replace(LEADING_STATE_MARKER, `${stateMarker(state)} `)
		: `${stateMarker(state)} ${content}`;
}

function frameBody(
	prefix: string[],
	body: string[],
	width: number,
	state: "running" | "success" | "error" | "cancelled",
): RenderedLines {
	const content = [...body];
	const headerIndex = content.findIndex((line) => !isBlank(line));
	const title = headerIndex >= 0 ? content.splice(headerIndex, 1)[0]! : "";
	while (content[0] !== undefined && isBlank(content[0])) content.shift();
	const leftRail = stateRail(state);
	const rightRail = renderSakuraSolid("│");
	const spacedContent = content.length > 0 ? ["", ...content] : content;
	return [
		...prefix,
		titleBorder(title, width),
		...spacedContent.map((line) => renderBoxedLine(line, width, leftRail, rightRail)),
		truncateToWidth(renderSakuraFrameGradient(bottomBorder(width)), width, ""),
	];
}

function isHorizontalBorder(line: string): boolean {
	const plain = stripAnsi(line).trim();
	return /^[─═]{3,}$/.test(plain) || /^[╭┌╔].*[╮┐╗]$/.test(plain) || /^[╰└╚].*[╯┘╝]$/.test(plain);
}

function stripOuterChrome(lines: RenderedLines): { prefix: string[]; body: string[] } {
	const body = [...lines];
	const prefix: string[] = [];
	if (body[0] !== undefined && isBlank(body[0])) prefix.push(body.shift()!);
	if (body[0] !== undefined && isHorizontalBorder(body[0])) body.shift();
	if (body.at(-1) !== undefined && isHorizontalBorder(body.at(-1)!)) body.pop();
	return { prefix, body };
}

function decorateToolMessage(lines: RenderedLines, width: number, runtime: ToolRuntime): RenderedLines {
	const isRead = runtime.toolName === "read";
	if (
		resolveRenderMode() !== "color" ||
		width <= 2 ||
		lines.length === 0 ||
		runtime.hideComponent ||
		(!isRead && (containsTerminalImage(lines) || containsResultImage(runtime)))
	) {
		return lines;
	}

	const { prefix, body: nativeBody } = stripOuterChrome(lines);
	const body = nativeBody.map(stripBackgroundAnsi);
	if (body.length === 0) return [...prefix, ...body];

	const state = toolState(runtime);
	const firstContent = body.findIndex((line) => !isBlank(line) && !containsTerminalImage([line]));
	if (firstContent >= 0) body[firstContent] = replaceStateMarker(body[firstContent]!, state);

	if (isRead) {
		return [...prefix, ...body].map((line) => {
			if (isBlank(line) || containsTerminalImage([line])) return line;
			return truncateToWidth(`  ${line}`, width, "");
		});
	}
	return frameBody(prefix, body, width, state);
}

function decorateBashMessage(lines: RenderedLines, width: number, runtime: BashRuntime): RenderedLines {
	if (resolveRenderMode() !== "color" || width <= 2 || lines.length === 0 || containsTerminalImage(lines)) return lines;

	const { prefix, body: nativeBody } = stripOuterChrome(lines);
	const body = nativeBody.map(stripBackgroundAnsi);
	const state = runtime.status === "error"
		? "error"
		: runtime.status === "cancelled"
			? "cancelled"
			: runtime.status === "running" || runtime.status === undefined
				? "running"
				: "success";
	const headerIndex = body.findIndex((line) => !isBlank(line));
	if (headerIndex >= 0) {
		const command = stripAnsi(runtime.command ?? stripAnsi(body[headerIndex]!).trim().replace(/^\$\s*/, ""));
		const meta = state === "error" && runtime.exitCode !== undefined
			? ` · exit ${runtime.exitCode}`
			: state === "cancelled"
				? " · cancelled"
				: "";
		body[headerIndex] = `${stateMarker(state)} Bash  ${command}${meta}`;
	}

	const settledBody = body.filter((line, index) => {
		if (index === headerIndex) return true;
		const plain = stripAnsi(line).trim();
		if (state === "error" && /^\(exit \d+\)$/.test(plain)) return false;
		if (state === "cancelled" && plain === "(cancelled)") return false;
		return true;
	});
	return frameBody(prefix, settledBody, width, state);
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
			const decorative = resolveRenderMode() === "color";
			if (
				decorative &&
				typeof width === "number" &&
				isObject(receiver) &&
				runtime.isPartial === false &&
				!runtime.hideComponent &&
				!containsResultImage(runtime)
			) {
				const cached = toolRenderCache.get(receiver);
				if (
					cached?.revision === (toolRenderRevision.get(receiver) ?? 0) &&
					cached.width === width &&
					cached.result === runtime.result &&
					cached.expanded === Boolean(runtime.expanded) &&
					cached.showImages === Boolean(runtime.showImages)
				) {
					return cached.lines;
				}
			}

			const contentWidth = typeof width === "number" ? toolPredecessorWidth(width, runtime) : width;
			const renderArgs = contentWidth === width ? args : [contentWidth, ...args.slice(1)];
			const rendered = Reflect.apply(predecessor, receiver, renderArgs);
			if (!isRenderedLines(rendered) || typeof width !== "number") return rendered;
			const framed = decorateToolMessage(rendered, width, runtime);
			if (
				decorative &&
				isObject(receiver) &&
				runtime.isPartial === false &&
				!runtime.hideComponent &&
				!containsResultImage(runtime)
			) {
				toolRenderCache.set(receiver, {
					revision: toolRenderRevision.get(receiver) ?? 0,
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
			if (isObject(receiver)) {
				toolRenderRevision.set(receiver, (toolRenderRevision.get(receiver) ?? 0) + 1);
				toolRenderCache.delete(receiver);
			}
			return Reflect.apply(predecessor, receiver, args);
		},
	);

	const cleanupToolUpdateDisplay = installPrototypePatch(
		ToolExecutionComponent.prototype,
		"updateDisplay",
		"tool-execution-update-display",
		({ predecessor, receiver, args }) => {
			const result = Reflect.apply(predecessor, receiver, args);
			if (isObject(receiver)) {
				toolRenderRevision.set(receiver, (toolRenderRevision.get(receiver) ?? 0) + 1);
				toolRenderCache.delete(receiver);
			}
			return result;
		},
	);

	const cleanupBashMessage = installPrototypePatch(
		BashExecutionComponent.prototype,
		"render",
		"bash-execution-render",
		({ predecessor, receiver, args }) => {
			const runtime = receiver as BashRuntime;
			const width = args[0];
			const decorative = resolveRenderMode() === "color";
			const outputLines = runtime.outputLines;
			const outputLength = outputLines?.length ?? 0;
			const lastOutputLine = outputLines?.at(-1);
			const settled = runtime.status !== undefined && runtime.status !== "running";

			if (decorative && typeof width === "number" && isObject(receiver) && settled) {
				const cached = bashRenderCache.get(receiver);
				if (
					cached?.width === width &&
					cached.outputLines === outputLines &&
					cached.outputLength === outputLength &&
					cached.lastOutputLine === lastOutputLine &&
					cached.status === runtime.status &&
					cached.expanded === Boolean(runtime.expanded)
				) {
					return cached.lines;
				}
			}

			const contentWidth = typeof width === "number" ? bashPredecessorWidth(width, runtime) : width;
			const renderArgs = contentWidth === width ? args : [contentWidth, ...args.slice(1)];
			const rendered = Reflect.apply(predecessor, receiver, renderArgs);
			if (!isRenderedLines(rendered) || typeof width !== "number") return rendered;
			const repainted = decorateBashMessage(rendered, width, runtime);
			if (decorative && isObject(receiver) && settled) {
				bashRenderCache.set(receiver, {
					width,
					outputLines,
					outputLength,
					lastOutputLine,
					status: runtime.status,
					expanded: Boolean(runtime.expanded),
					lines: repainted,
				});
			}
			return repainted;
		},
	);

	const cleanupBashInvalidate = installPrototypePatch(
		BashExecutionComponent.prototype,
		"invalidate",
		"bash-execution-invalidate",
		({ predecessor, receiver, args }) => {
			if (isObject(receiver)) bashRenderCache.delete(receiver);
			return Reflect.apply(predecessor, receiver, args);
		},
	);

	let cleaned = false;
	return () => {
		if (cleaned) return;
		cleaned = true;
		cleanupBashInvalidate();
		cleanupBashMessage();
		cleanupToolUpdateDisplay();
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
