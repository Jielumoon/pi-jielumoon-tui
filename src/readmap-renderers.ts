import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getLanguageFromPath, highlightCode, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Text,
	getCapabilities,
	hyperlink,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { resolveRenderMode, type RenderMode } from "./render-mode";

/** 本扩展已接管的工具对象标记，保证 reload 幂等。 */
export const READMAP_RENDERER_MARK = Symbol.for("pi-jielumoon.readmap-renderer");

/** 接管 readmap 的常用文件/命令工具；其余 readmap 工具保持原 renderer。 */
export const TARGET_TOOL_NAMES = new Set(["read", "edit", "write", "bash", "ls"]);

const EXPAND_KEY = "Ctrl+O";
const EXPAND_HINT = ` · ${EXPAND_KEY}`;
const HASHLINE_RE = /^(\d+):([0-9a-fA-F]+)\|(.*)$/;
/** 短 bash：不超过此行数时折叠态也整段展示。 */
const BASH_SHORT_MAX_LINES = 4;
const BASH_SHORT_MAX_CHARS = 2_000;
/** 长 bash 折叠态预览行数。 */
const BASH_COLLAPSED_PREVIEW_LINES = 4;
/** write 折叠态固定保留的终端显示行。 */
const WRITE_COLLAPSED_DISPLAY_LINES = 8;
const WRITE_ANIMATION_INTERVAL_MS = 40;
const WRITE_ANIMATION_MAX_STEP = 64;
const WRITE_ANIMATION_CATCHUP_TICKS = 6;
const WRITE_HIGHLIGHT_MAX_CHARS = 8_192;
/** edit/write diff 折叠态最多展示的变更行。 */
const DIFF_COLLAPSED_PREVIEW_LINES = 6;
/** ls 折叠态最多展示的目录条目。 */
const LS_COLLAPSED_PREVIEW_ENTRIES = 8;
const SPLIT_DIFF_MIN_WIDTH = 120;
const SUMMARY_DIFF_MAX_WIDTH = 23;


type RenderPresentation = {
	mode: RenderMode;
	diagnostics: boolean;
	theme: ThemeLike | undefined;
};

type ThemeLike = {
	// color 用 string 宽化，兼容 Pi ThemeColor 与 mock theme
	fg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
};

function asThemeLike(theme: unknown): ThemeLike | undefined {
	return theme as ThemeLike | undefined;
}

type RenderContextLike = {
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

type RenderOptionsLike = {
	expanded?: boolean;
	isPartial?: boolean;
};

export type ReadmapRendererSettings = {
	writeAnimation?: boolean;
};

const DEFAULT_READMAP_RENDERER_SETTINGS: ReadmapRendererSettings = {
	writeAnimation: true,
};

const readmapRendererSettings = new WeakMap<object, ReadmapRendererSettings>();

type ToolPhase = "running" | "success" | "error" | "noop";

type ToolResultLike = {
	content?: Array<{ type?: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
};

type DiffEntry =
	| { kind: "context"; oldLine: number; newLine: number; text: string }
	| { kind: "add"; newLine: number; text: string }
	| { kind: "remove"; oldLine: number; text: string }
	| { kind: "meta"; text: string };

type DiffSpan = { kind: "equal" | "add" | "remove"; text: string };

type InlineDiff = {
	removeLineIndex: number;
	addLineIndex: number;
	removeSpans: DiffSpan[];
	addSpans: DiffSpan[];
};

type DiffBlockRange = {
	kind: "add" | "remove";
	startLine: number;
	endLine: number;
};

type DiffData = {
	version?: number;
	entries: DiffEntry[];
	stats: { added: number; removed: number; context?: number };
	language?: string;
	blockRanges?: DiffBlockRange[];
	inlineDiffs?: InlineDiff[];
};

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

// ─── theme / width ───────────────────────────────────────────────

function themeFg(theme: ThemeLike | undefined, color: string, text: string): string {
	if (!theme?.fg) return text;
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

function themeBold(theme: ThemeLike | undefined, text: string): string {
	if (!theme?.bold) return text;
	try {
		return theme.bold(text);
	} catch {
		return text;
	}
}

export function normalizeWidth(width: unknown, fallback = 80): number {
	return typeof width === "number" && Number.isFinite(width) && width > 0
		? Math.floor(width)
		: fallback;
}

export function clampLine(line: string, width: number | undefined): string {
	if (width === undefined || width === null) return line;
	const w = normalizeWidth(width);
	return visibleWidth(line) <= w ? line : truncateToWidth(line, w);
}

export function clampLines(lines: readonly string[], width: number | undefined): string[] {
	return lines.map((line) => clampLine(line, width));
}

/**
 * 工具参数和结果来自文件、命令或模型，不能让它们携带控制终端的转义序列。
 * 诊断模式额外把 tab、尾随空格和双向控制字符变成可见标记。
 */
const BIDI_CONTROL_CODES = new Set([
	0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
	0x2066, 0x2067, 0x2068, 0x2069,
]);

function sanitizeTerminalText(value: string, diagnostics = false): string {
	let safe = "";
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (BIDI_CONTROL_CODES.has(code)) {
			if (diagnostics) safe += "⟦bidi⟧";
			continue;
		}
		if (code === 0x1b) {
			const kind = value[index + 1];
			if (kind === "]") {
				index += 2;
				while (index < value.length) {
					if (value.charCodeAt(index) === 0x07) break;
					if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") {
						index++;
						break;
					}
					index++;
				}
				continue;
			}
			if (kind === "[") {
				index += 2;
				while (index < value.length) {
					const byte = value.charCodeAt(index);
					if (byte >= 0x40 && byte <= 0x7e) break;
					index++;
				}
				continue;
			}
			if (kind === "P" || kind === "X" || kind === "^" || kind === "_") {
				index += 2;
				while (index < value.length) {
					if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") {
						index++;
						break;
					}
					index++;
				}
				continue;
			}
			if (kind !== undefined) index++;
			continue;
		}
		if (code === 0x0a) {
			safe += "\n";
			continue;
		}
		if (code === 0x09) {
			safe += diagnostics ? "⇥" : " ";
			continue;
		}
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
		safe += value[index]!;
	}
	return diagnostics ? safe.replace(/ +(?=\n|$)/g, (spaces) => "·".repeat(spaces.length)) : safe;
}


function resolvePresentation(theme: unknown): RenderPresentation {
	const requested = resolveRenderMode();
	return {
		mode: requested,
		diagnostics: process.env.PI_READMAP_DIAGNOSTICS === "1",
		theme: requested === "color" ? asThemeLike(theme) : undefined,
	};
}

function displayText(value: string, presentation: RenderPresentation): string {
	return sanitizeTerminalText(value, presentation.diagnostics);
}

function styleText(presentation: RenderPresentation, color: string, text: string): string {
	return themeFg(presentation.theme, color, text);
}

function padStartVisible(value: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(value))) + value;
}

function padEndVisible(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function collapsedHint(
	shown: number,
	total: number,
	unit: string,
	expandable = true,
	presentation?: RenderPresentation,
): string {
	const safeTotal = Math.max(0, Math.floor(total));
	const safeShown = Math.max(0, Math.min(Math.floor(shown), safeTotal));
	const hidden = Math.max(0, safeTotal - safeShown);
	const hint = `${hidden} more ${unit}${expandable ? EXPAND_HINT : ""}`;
	return presentation?.mode === "screen-reader" ? `output: ${hint}` : `… ${hint}`;
}

function wrapWithHangingIndent(prefix: string, content: string, width: number): string[] {
	const combined = prefix + content;
	if (visibleWidth(combined) <= width) return [combined];
	const prefixWidth = visibleWidth(prefix);
	const contentWidth = Math.max(1, width - prefixWidth);
	const wrapped = wrapTextWithAnsi(content, contentWidth);
	if (wrapped.length === 0) return [clampLine(prefix, width)];
	const indent = " ".repeat(prefixWidth);
	return wrapped.map((line, index) =>
		clampLine(index === 0 ? prefix + line : indent + line, width),
	);
}

function wrapHashlines(text: string, width: number, presentation: RenderPresentation): string[] {
	const out: string[] = [];
	const lines = displayText(text, presentation).split("\n");
	const parsed = lines.map((line) => {
		const match = line.match(HASHLINE_RE);
		return match
			? { lineNo: match[1]!, hash: match[2]!, content: match[3] ?? "" }
			: undefined;
	});
	const hashlineParts = parsed.filter(
		(line): line is NonNullable<typeof line> => line !== undefined,
	);
	const lineNoWidth = hashlineParts.reduce(
		(max, line) => Math.max(max, visibleWidth(line.lineNo)),
		1,
	);
	const hashWidth = hashlineParts.reduce(
		(max, line) => Math.max(max, visibleWidth(line.hash)),
		1,
	);

	for (const [index, line] of lines.entries()) {
		const part = parsed[index];
		if (!part) {
			out.push(
				...wrapTextWithAnsi(line, width).map((item) =>
					clampLine(styleText(presentation, "toolOutput", item), width),
				),
			);
			continue;
		}
		const prefix =
			styleText(presentation, "dim", padStartVisible(part.lineNo, lineNoWidth)) +
			styleText(presentation, "muted", ":") +
			styleText(presentation, "dim", padEndVisible(part.hash, hashWidth)) +
			styleText(presentation, "muted", "|");
		out.push(...wrapWithHangingIndent(prefix, styleText(presentation, "toolOutput", part.content), width));
	}
	return out;
}

function linkPath(styled: string, rawPath: string, cwd: string | undefined): string {
	try {
		if (!getCapabilities().hyperlinks) return styled;
		const absolute = rawPath.startsWith("/")
			? rawPath
			: join(cwd && cwd.length > 0 ? cwd : process.cwd(), rawPath);
		return hyperlink(styled, pathToFileURL(absolute).href);
	} catch {
		return styled;
	}
}

function shortenPath(path: string, max = 48): string {
	if (visibleWidth(path) <= max) return path;
	const parts = path.replaceAll("\\", "/").split("/");
	if (parts.length <= 2) return truncateToWidth(path, max);
	let result = parts[parts.length - 1] ?? path;
	for (let i = parts.length - 2; i >= 0; i--) {
		const candidate = `${parts[i]}/${result}`;
		if (visibleWidth(candidate) + 2 > max) break;
		result = candidate;
	}
	const shortened = `…/${result}`;
	return visibleWidth(shortened) <= max ? shortened : truncateToWidth(path, max);
}

function textOf(result: ToolResultLike, presentation?: RenderPresentation): string {
	const parts = result.content
		?.filter((item) => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text);
	return displayText(parts?.join("\n") ?? "", presentation ?? {
		mode: "color",
		diagnostics: false,
		theme: undefined,
	});
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}


function toolLabel(theme: ThemeLike | undefined, name: string): string {
	const label = name.length > 0 ? `${name[0]!.toUpperCase()}${name.slice(1)}` : "Tool";
	return themeFg(theme, "toolTitle", themeBold(theme, label));
}

function phaseMarker(presentation: RenderPresentation, phase: ToolPhase): string {
	if (presentation.mode !== "color") return "";
	const marker = phase === "running" ? "◇" : phase === "error" ? "×" : phase === "noop" ? "·" : "✓";
	const color = phase === "running" ? "accent" : phase === "error" ? "error" : phase === "noop" ? "dim" : "success";
	return styleText(presentation, color, marker);
}

function isExpanded(
	options: { expanded?: boolean } | undefined,
	context: RenderContextLike | undefined,
): boolean {
	return context?.expanded ?? options?.expanded ?? false;
}

function reuseOrCreateText(last: Component | undefined, text: string): Text {
	if (last instanceof Text) {
		last.setText(text);
		return last;
	}
	return new Text(text, 0, 0);
}


type WidthLineRenderer = (width: number) => string[];

/** 仅延迟依赖终端宽度的纯文本排版；外框仍由 message-borders 负责。 */
class WidthAwareTextComponent implements Component {
	private renderLines: WidthLineRenderer;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(renderLines: WidthLineRenderer) {
		this.renderLines = renderLines;
	}

	update(renderLines: WidthLineRenderer): void {
		this.renderLines = renderLines;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const normalized = normalizeWidth(width);
		if (this.cachedLines && this.cachedWidth === normalized) return this.cachedLines;
		this.cachedLines = clampLines(this.renderLines(normalized), normalized);
		this.cachedWidth = normalized;
		return this.cachedLines;
	}
}

function reuseOrCreateWidthAware(
	last: Component | undefined,
	renderLines: WidthLineRenderer,
): WidthAwareTextComponent {
	if (last instanceof WidthAwareTextComponent) {
		last.update(renderLines);
		return last;
	}
	return new WidthAwareTextComponent(renderLines);
}


// ─── write stream ─────────────────────────────────────────────────

type WriteHighlightCache = {
	content: string;
	path: string;
	mode: RenderMode;
	theme: ThemeLike | undefined;
	rawLines: string[];
	highlightedLines: string[] | undefined;
};

type WriteLineLayout = {
	prefix: string;
	continuation: string;
	segments: string[];
};

function safeHighlightCode(code: string, language: string): string[] | undefined {
	try {
		return highlightCode(code, language);
	} catch {
		return undefined;
	}
}

function updateWriteHighlightCache(
	cache: WriteHighlightCache | undefined,
	content: string,
	path: string,
	presentation: RenderPresentation,
): WriteHighlightCache {
	if (
		cache &&
		cache.content === content &&
		cache.path === path &&
		cache.mode === presentation.mode &&
		cache.theme === presentation.theme
	) return cache;

	const rawLines = content.split("\n");
	const language = presentation.mode === "color" && content.length <= WRITE_HIGHLIGHT_MAX_CHARS && path
		? getLanguageFromPath(path)
		: undefined;
	return {
		content,
		path,
		mode: presentation.mode,
		theme: presentation.theme,
		rawLines,
		highlightedLines: language ? safeHighlightCode(content, language) : undefined,
	};
}

function commonPrefixBoundary(left: string, right: string): number {
	const max = Math.min(left.length, right.length);
	let index = 0;
	while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) index++;
	if (index > 0) {
		const previous = left.charCodeAt(index - 1);
		if (previous >= 0xd800 && previous <= 0xdbff) index--;
	}
	return index;
}

function advanceCodePoints(value: string, offset: number, count: number): number {
	let next = Math.max(0, Math.min(offset, value.length));
	for (let advanced = 0; advanced < count && next < value.length; advanced++) {
		const codePoint = value.codePointAt(next);
		next += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
	}
	return next;
}

/** 纯推进策略，供组件与确定性测试共用。 */
export function advanceWriteReveal(current: string, target: string): string {
	if (current === target) return target;
	let prefixLength = current.length;
	if (!target.startsWith(current)) prefixLength = commonPrefixBoundary(current, target);
	const backlog = Math.max(0, target.length - prefixLength);
	const step = Math.min(
		WRITE_ANIMATION_MAX_STEP,
		Math.max(1, Math.ceil(backlog / WRITE_ANIMATION_CATCHUP_TICKS)),
	);
	return target.slice(0, advanceCodePoints(target, prefixLength, step));
}

function writeInput(args: unknown): { path: string; content: string } {
	const record = asRecord(args);
	return {
		path: typeof record?.path === "string" ? record.path : "",
		content: typeof record?.content === "string" ? record.content : "",
	};
}

function trailingTextByWidth(value: string, width: number): string {
	if (width <= 0 || value.length === 0) return "";
	const sourceLimit = Math.max(1_024, width * 4);
	let suffixStart = Math.max(0, value.length - sourceLimit);
	const firstCode = value.charCodeAt(suffixStart);
	if (suffixStart > 0 && firstCode >= 0xdc00 && firstCode <= 0xdfff) suffixStart--;
	const suffix = Array.from(value.slice(suffixStart));
	let low = 0;
	let high = suffix.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (visibleWidth(suffix.slice(middle).join("")) > width) low = middle + 1;
		else high = middle;
	}
	return suffix.slice(low).join("");
}

function writeLineLayout(
	rawLine: string,
	highlightedLine: string | undefined,
	lineNumber: number,
	lineNumberWidth: number,
	width: number,
	presentation: RenderPresentation,
	cursor: boolean,
	maxTailRows?: number,
): WriteLineLayout {
	const screenReaderPrefix = `line ${lineNumber}: `;
	const colorPrefix =
		styleText(presentation, "dim", padStartVisible(String(lineNumber), lineNumberWidth)) +
		styleText(presentation, "muted", " │ ");
	const candidate = presentation.mode === "screen-reader" ? screenReaderPrefix : colorPrefix;
	const prefix = visibleWidth(candidate) < width ? candidate : "";
	const continuation = " ".repeat(visibleWidth(prefix));
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	let visibleRaw = rawLine;
	if (highlightedLine === undefined && maxTailRows !== undefined) {
		const cursorWidth = cursor ? 1 : 0;
		const totalWidth = visibleWidth(rawLine) + cursorWidth;
		const rowBudget = contentWidth * maxTailRows;
		if (totalWidth > rowBudget) {
			const finalRowWidth = totalWidth % contentWidth || contentWidth;
			const rawBudget = Math.max(0, finalRowWidth + contentWidth * (maxTailRows - 1) - cursorWidth);
			visibleRaw = trailingTextByWidth(rawLine, rawBudget);
		}
	}
	const styledLine = highlightedLine ?? styleText(presentation, "toolOutput", visibleRaw);
	const body = cursor ? `${styledLine}${styleText(presentation, "accent", "▏")}` : styledLine;
	const wrapped = wrapTextWithAnsi(body, contentWidth);
	return {
		prefix,
		continuation,
		segments: wrapped.length > 0 ? wrapped : [""],
	};
}

function materializeWriteLine(layout: WriteLineLayout, start = 0): string[] {
	return layout.segments.slice(start).map((segment, index) =>
		`${index === 0 ? layout.prefix : layout.continuation}${segment}`,
	);
}

function renderWritePreviewLines(
	content: string,
	path: string,
	presentation: RenderPresentation,
	width: number,
	expanded: boolean,
	cursor: boolean,
	cache?: WriteHighlightCache,
): { lines: string[]; cache: WriteHighlightCache } {
	const normalizedWidth = normalizeWidth(width);
	const nextCache = updateWriteHighlightCache(cache, content, path, presentation);
	if (content.length === 0 && !cursor) {
		const empty = presentation.mode === "screen-reader"
			? "empty file"
			: styleText(presentation, "dim", "empty file");
		return { lines: [clampLine(empty, normalizedWidth)], cache: nextCache };
	}

	const lastIndex = nextCache.rawLines.length - 1;
	const lineNumberWidth = String(Math.max(1, nextCache.rawLines.length)).length;
	const layoutAt = (index: number, maxTailRows?: number): WriteLineLayout => writeLineLayout(
		nextCache.rawLines[index] ?? "",
		nextCache.highlightedLines?.[index],
		index + 1,
		lineNumberWidth,
		normalizedWidth,
		presentation,
		cursor && index === lastIndex,
		maxTailRows,
	);
	if (expanded) {
		const lines = nextCache.rawLines.flatMap((_line, index) => materializeWriteLine(layoutAt(index)));
		return { lines: clampLines(lines, normalizedWidth), cache: nextCache };
	}

	const lines: string[] = [];
	for (let index = lastIndex; index >= 0 && lines.length < WRITE_COLLAPSED_DISPLAY_LINES; index--) {
		const remaining = WRITE_COLLAPSED_DISPLAY_LINES - lines.length;
		const layout = layoutAt(index, remaining);
		const start = Math.max(0, layout.segments.length - remaining);
		lines.unshift(...materializeWriteLine(layout, start));
	}
	return { lines: clampLines(lines.slice(-WRITE_COLLAPSED_DISPLAY_LINES), normalizedWidth), cache: nextCache };
}

const activeWriteAnimations = new Set<WriteCallComponent>();
let writeAnimationTimer: ReturnType<typeof setInterval> | undefined;

function stopWriteAnimationTimerIfIdle(): void {
	if (activeWriteAnimations.size > 0 || writeAnimationTimer === undefined) return;
	clearInterval(writeAnimationTimer);
	writeAnimationTimer = undefined;
}

function scheduleWriteAnimation(component: WriteCallComponent): void {
	activeWriteAnimations.add(component);
	if (writeAnimationTimer !== undefined) return;
	writeAnimationTimer = setInterval(() => {
		for (const active of [...activeWriteAnimations]) {
			try {
				if (!active.advanceAnimation()) activeWriteAnimations.delete(active);
			} catch {
				active.stop();
				activeWriteAnimations.delete(active);
			}
		}
		stopWriteAnimationTimerIfIdle();
	}, WRITE_ANIMATION_INTERVAL_MS);
	writeAnimationTimer.unref?.();
}

function unscheduleWriteAnimation(component: WriteCallComponent): void {
	activeWriteAnimations.delete(component);
	stopWriteAnimationTimerIfIdle();
}

function stopAllWriteAnimations(): void {
	for (const component of [...activeWriteAnimations]) component.stop();
	activeWriteAnimations.clear();
	stopWriteAnimationTimerIfIdle();
}

export class WriteCallComponent implements Component {
	private targetContent = "";
	private revealedContent = "";
	private path = "";
	private cwd: string | undefined;
	private expanded = false;
	private animationEnabled = false;
	private showCursor = false;
	private invalidateRow: (() => void) | undefined;
	private presentation: RenderPresentation = { mode: "color", diagnostics: false, theme: undefined };
	private highlightCache: WriteHighlightCache | undefined;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	update(
		args: unknown,
		presentation: RenderPresentation,
		context: RenderContextLike,
		settings: ReadmapRendererSettings,
	): void {
		const input = writeInput(args);
		const nextPath = displayText(input.path, presentation);
		const nextTarget = displayText(input.content, presentation);
		if (!nextTarget.startsWith(this.revealedContent)) {
			this.revealedContent = nextTarget.slice(
				0,
				commonPrefixBoundary(this.revealedContent, nextTarget),
			);
		}
		this.targetContent = nextTarget;
		this.path = nextPath;
		this.cwd = context.cwd;
		this.expanded = context.expanded ?? false;
		this.invalidateRow = context.invalidate;
		this.presentation = presentation;
		this.animationEnabled =
			settings.writeAnimation !== false &&
			presentation.mode === "color" &&
			context.argsComplete !== true &&
			context.isPartial !== false;
		this.showCursor = this.animationEnabled;

		if (!this.animationEnabled) {
			this.revealedContent = this.targetContent;
			unscheduleWriteAnimation(this);
		} else if (this.revealedContent !== this.targetContent) {
			scheduleWriteAnimation(this);
		} else {
			unscheduleWriteAnimation(this);
		}
		this.invalidate();
	}

	advanceAnimation(): boolean {
		if (!this.animationEnabled || this.revealedContent === this.targetContent) return false;
		const next = advanceWriteReveal(this.revealedContent, this.targetContent);
		if (next === this.revealedContent) return false;
		this.revealedContent = next;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.invalidateRow?.();
		return this.animationEnabled && this.revealedContent !== this.targetContent;
	}

	stop(): void {
		this.animationEnabled = false;
		this.showCursor = false;
		unscheduleWriteAnimation(this);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const normalizedWidth = normalizeWidth(width);
		if (this.cachedLines && this.cachedWidth === normalizedWidth) return this.cachedLines;
		const preview = renderWritePreviewLines(
			this.revealedContent,
			this.path,
			this.presentation,
			normalizedWidth,
			this.expanded,
			this.showCursor,
			this.highlightCache,
		);
		this.highlightCache = preview.cache;
		const count = this.revealedContent.length === 0 ? 0 : preview.cache.rawLines.length;
		const header = renderToolHeader(
			"write",
			{ path: this.path },
			this.presentation,
			{ cwd: this.cwd, expanded: this.expanded },
			{
				phase: "running",
				meta: [`${count} ${count === 1 ? "line" : "lines"}`],
				expandable: !this.expanded && this.revealedContent.length > 0,
			},
		);
		this.cachedWidth = normalizedWidth;
		this.cachedLines = clampLines([header, ...preview.lines], normalizedWidth);
		return this.cachedLines;
	}
}

function reuseOrCreateWriteCall(
	last: Component | undefined,
	args: unknown,
	presentation: RenderPresentation,
	context: RenderContextLike,
	settings: ReadmapRendererSettings,
): WriteCallComponent {
	const component = last instanceof WriteCallComponent ? last : new WriteCallComponent();
	component.update(args, presentation, context, settings);
	return component;
}

// ─── diff body ───────────────────────────────────────────────────

function isDiffData(value: unknown): value is DiffData {
	const record = asRecord(value);
	if (!record || !Array.isArray(record.entries)) return false;
	const stats = asRecord(record.stats);
	return typeof stats?.added === "number" && typeof stats?.removed === "number";
}

function entryText(entry: DiffEntry, presentation: RenderPresentation): string {
	return "text" in entry ? displayText(entry.text, presentation) : "";
}

function entryLineNo(entry: DiffEntry): string {
	if (entry.kind === "add") return String(entry.newLine);
	if (entry.kind === "remove") return String(entry.oldLine);
	if (entry.kind === "context") return String(entry.newLine);
	return "";
}

function entryMarker(entry: DiffEntry): string {
	if (entry.kind === "add") return "+";
	if (entry.kind === "remove") return "-";
	return " ";
}

function tintEntry(presentation: RenderPresentation, entry: DiffEntry, text: string): string {
	if (entry.kind === "add") return styleText(presentation, "toolDiffAdded", text);
	if (entry.kind === "remove") return styleText(presentation, "toolDiffRemoved", text);
	return styleText(presentation, "toolOutput", text);
}

function renderDiffLines(
	diffData: DiffData,
	theme: ThemeLike | undefined,
	width: number,
	expanded: boolean,
	presentation?: RenderPresentation,
): string[] {
	const w = normalizeWidth(width);
	const p = presentation ?? { mode: "color" as const, diagnostics: false, theme: asThemeLike(theme) };
	const entries = diffData.entries.filter((entry) => entry.kind !== "meta");
	const mode =
		p.mode === "screen-reader"
			? "unified"
			: w < SUMMARY_DIFF_MAX_WIDTH
				? "summary"
				: w < 50
					? "compact"
					: w >= SPLIT_DIFF_MIN_WIDTH && entries.some((entry) => entry.kind === "remove" || entry.kind === "context")
						? "split"
						: "unified";
	const renderable = mode === "compact" ? entries.filter((entry) => entry.kind !== "context") : entries;
	const lineNumberWidth = renderable.reduce(
		(max, entry) => Math.max(max, visibleWidth(entryLineNo(entry))),
		1,
	);
	const oldLineNumberWidth = renderable.reduce(
		(max, entry) => entry.kind === "add" ? max : Math.max(max, visibleWidth(String(entry.oldLine))),
		1,
	);
	const newLineNumberWidth = renderable.reduce(
		(max, entry) => entry.kind === "remove" ? max : Math.max(max, visibleWidth(String(entry.newLine))),
		1,
	);
	const rows: string[] = [];
	let shown = 0;
	const splitPairs = new Map<number, number>();
	const splitPairTargets = new Set<number>();
	if (mode === "split" && Array.isArray(diffData.inlineDiffs)) {
		for (const pair of diffData.inlineDiffs) {
			if (!Number.isInteger(pair.removeLineIndex) || !Number.isInteger(pair.addLineIndex)) continue;
			const removeEntry = diffData.entries[pair.removeLineIndex];
			const addEntry = diffData.entries[pair.addLineIndex];
			if (
				removeEntry?.kind !== "remove" ||
				addEntry?.kind !== "add" ||
				pair.addLineIndex <= pair.removeLineIndex ||
				splitPairs.has(pair.removeLineIndex) ||
				splitPairTargets.has(pair.addLineIndex)
			) continue;
			splitPairs.set(pair.removeLineIndex, pair.addLineIndex);
			splitPairTargets.add(pair.addLineIndex);
		}
	}

	const validSpan = (value: unknown): value is DiffSpan => {
		const span = asRecord(value);
		return (
			span !== undefined &&
			(span.kind === "equal" || span.kind === "add" || span.kind === "remove") &&
			typeof span.text === "string"
		);
	};
	const inlineText = (index: number, entry: DiffEntry): string => {
		const pair = Array.isArray(diffData.inlineDiffs)
			? diffData.inlineDiffs.find((candidate) => {
					const record = asRecord(candidate);
					return (
						record !== undefined &&
						typeof record.removeLineIndex === "number" &&
						typeof record.addLineIndex === "number" &&
						(entry.kind === "remove"
							? record.removeLineIndex === index
							: entry.kind === "add" && record.addLineIndex === index)
					);
				})
			: undefined;
		const spans = pair
			? entry.kind === "remove"
				? pair.removeSpans
				: entry.kind === "add"
					? pair.addSpans
					: undefined
			: undefined;
		if (!Array.isArray(spans) || !spans.every(validSpan)) return entryText(entry, p);
		return spans
			.map((span) =>
				styleText(
					p,
					span.kind === "add" ? "toolDiffAdded" : span.kind === "remove" ? "toolDiffRemoved" : "toolOutput",
					displayText(span.text, p),
				),
			)
			.join("");
	};
	const hunkLabel = (entry: DiffEntry): string | undefined => {
		if (!Array.isArray(diffData.blockRanges)) return undefined;
		const line = entry.kind === "add" ? entry.newLine : entry.kind === "remove" ? entry.oldLine : undefined;
		if (line === undefined) return undefined;
		const range = diffData.blockRanges.find((candidate) => {
			const record = asRecord(candidate);
			return (
				record !== undefined &&
				record.kind === entry.kind &&
				typeof record.startLine === "number" &&
				typeof record.endLine === "number" &&
				record.startLine === line
			);
		});
		if (!range) return undefined;
		const language = typeof diffData.language === "string" ? ` · ${displayText(diffData.language, p)}` : "";
		const label = `${entry.kind === "add" ? "+" : "-"} hunk ${range.startLine}-${range.endLine}${language}`;
		return p.mode === "screen-reader" ? `hunk: ${label}` : styleText(p, "muted", `┄ ${label}`);
	};
	const addUnified = (index: number, entry: DiffEntry): void => {
		const marker = entryMarker(entry);
		const number = padStartVisible(entryLineNo(entry), lineNumberWidth);
		const prefix =
			p.mode === "screen-reader"
				? `diff: ${marker} ${number}: `
				: mode === "compact"
					? `▌${marker} ${number} `
					: `▌${marker} ${number} │ `;
		const body = inlineText(index, entry);
			const wrapped = wrapWithHangingIndent(prefix, body, w);
			rows.push(...wrapped.map((line) => tintEntry(p, entry, line)));
	};
	const addSplit = (
		leftIndex: number,
		leftEntry: DiffEntry,
		rightIndex?: number,
		rightEntry?: DiffEntry,
	): void => {
		const paneWidth = Math.max(10, Math.floor((w - 3) / 2));
		const gap = " │ ";
		const blank = " ".repeat(paneWidth);
		const oldEntry = leftEntry.kind === "remove" || leftEntry.kind === "context" ? leftEntry : undefined;
		const newEntry = rightEntry ?? leftEntry;
		const currentEntry = newEntry.kind === "add" || newEntry.kind === "context" ? newEntry : undefined;
		const oldBody = oldEntry ? inlineText(leftIndex, oldEntry) : "";
		const newBody = currentEntry ? inlineText(rightIndex ?? leftIndex, currentEntry) : "";
		const oldMarker = oldEntry?.kind === "context" ? " " : "-";
		const newMarker = currentEntry?.kind === "context" ? " " : "+";
		const oldPrefix = `▌${oldMarker} ${padStartVisible(oldEntry ? String(oldEntry.oldLine) : "", oldLineNumberWidth)} │ `;
		const newPrefix = `▌${newMarker} ${padStartVisible(currentEntry ? String(currentEntry.newLine) : "", newLineNumberWidth)} │ `;
		const oldLines = oldEntry
			? wrapWithHangingIndent(oldPrefix, oldBody, paneWidth).map((line) => tintEntry(p, oldEntry, line))
			: [];
		const newLines = currentEntry
			? wrapWithHangingIndent(newPrefix, newBody, paneWidth).map((line) => tintEntry(p, currentEntry, line))
			: [];
		const rowsToRender = Math.max(oldLines.length, newLines.length, 1);
		for (let row = 0; row < rowsToRender; row++) {
			rows.push(`${padEndVisible(oldLines[row] ?? blank, paneWidth)}${gap}${newLines[row] ?? blank}`);
		}
	};

	if (mode !== "summary") {
		const consumedSplitEntries = new Set<number>();
		for (let index = 0; index < diffData.entries.length; index++) {
			const entry = diffData.entries[index];
			if (
				!entry ||
				consumedSplitEntries.has(index) ||
				entry.kind === "meta" ||
				(mode === "compact" && entry.kind === "context")
			) continue;
			if (!expanded && shown >= DIFF_COLLAPSED_PREVIEW_LINES) break;

			const pairedAddIndex = mode === "split" && entry.kind === "remove"
				? splitPairs.get(index)
				: undefined;
			const pairedAdd = pairedAddIndex === undefined ? undefined : diffData.entries[pairedAddIndex];
			const hasPair = pairedAdd?.kind === "add";
			if (hasPair && !expanded && shown + 2 > DIFF_COLLAPSED_PREVIEW_LINES) break;

			const labels = [hunkLabel(entry), hasPair ? hunkLabel(pairedAdd) : undefined];
			for (const label of new Set(labels.filter((item): item is string => item !== undefined))) {
				rows.push(clampLine(label, w));
			}
			if (hasPair && pairedAddIndex !== undefined) {
				addSplit(index, entry, pairedAddIndex, pairedAdd);
				consumedSplitEntries.add(pairedAddIndex);
				shown += 2;
			} else if (mode === "split") {
				addSplit(index, entry);
				shown++;
			} else {
				addUnified(index, entry);
				shown++;
			}
		}
	}
	if (!expanded && renderable.length > shown) {
		rows.push(clampLine(collapsedHint(shown, renderable.length, "diff lines", true, p), w));
	}
	return clampLines(rows, w);
}

/** 宽度自适应的 diff 内容组件；不自画外框。 */
export class DiffBodyComponent implements Component {
	private prefixLines: string[];
	private diffData: DiffData;
	private theme: ThemeLike | undefined;
	private expanded: boolean;
	private presentation: RenderPresentation | undefined;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(options: {
		prefixLines?: string[];
		diffData: DiffData;
		theme?: ThemeLike;
		expanded?: boolean;
		presentation?: RenderPresentation;
	}) {
		this.prefixLines = options.prefixLines ?? [];
		this.diffData = options.diffData;
		this.theme = options.theme;
		this.expanded = options.expanded ?? true;
		this.presentation = options.presentation;
	}

	update(options: {
		prefixLines?: string[];
		diffData: DiffData;
		theme?: ThemeLike;
		expanded?: boolean;
		presentation?: RenderPresentation;
	}): void {
		this.prefixLines = options.prefixLines ?? [];
		this.diffData = options.diffData;
		this.theme = options.theme;
		this.expanded = options.expanded ?? true;
		this.presentation = options.presentation;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const normalized = normalizeWidth(width);
		if (this.cachedLines && this.cachedWidth === normalized) return this.cachedLines;
		const p = this.presentation ?? {
			mode: "color" as const,
			diagnostics: false,
			theme: asThemeLike(this.theme),
		};
		const lines = this.prefixLines.map((line) => clampLine(line, normalized));
		lines.push(...renderDiffLines(this.diffData, this.theme, normalized, this.expanded, p));
		this.cachedLines = clampLines(lines, normalized);
		this.cachedWidth = normalized;
		return this.cachedLines;
	}
}

function reuseOrCreateDiff(
	last: Component | undefined,
	options: {
		prefixLines: string[];
		diffData: DiffData;
		theme?: ThemeLike;
		expanded: boolean;
		presentation?: RenderPresentation;
	},
): DiffBodyComponent {
	if (last instanceof DiffBodyComponent) {
		last.update(options);
		return last;
	}
	return new DiffBodyComponent(options);
}

// ─── canonical tool header ─────────────────────────────────────────

function rangeSuffix(args: Record<string, unknown> | undefined): string {
	const offset = args?.offset;
	const limit = args?.limit;
	if (typeof offset === "number" && typeof limit === "number" && offset > 0 && limit > 0) {
		return `:${offset}–${offset + limit - 1}`;
	}
	return "";
}

type ToolSubject = { target: string; meta: string[] };

function toolSubject(
	name: string,
	args: unknown,
	presentation: RenderPresentation,
	context: RenderContextLike,
): ToolSubject {
	const record = asRecord(args) ?? {};
	const path = typeof record.path === "string" ? displayText(record.path, presentation) : name === "ls" ? "." : "";
	const linkedPath = (): string => {
		if (!path) return styleText(presentation, "toolOutput", "…");
		const shown = shortenPath(path);
		const styled = styleText(presentation, "syntaxType", shown);
		return presentation.mode === "color" ? linkPath(styled, path, context.cwd) : styled;
	};

	if (name === "read") {
		const meta: string[] = [];
		if (typeof record.symbol === "string") meta.push(`symbol: ${displayText(record.symbol, presentation)}`);
		const suffix = rangeSuffix(record);
		const target = linkedPath();
		return {
			target: path && suffix ? `${target}${styleText(presentation, "syntaxNumber", suffix)}` : target,
			meta,
		};
	}
	if (name === "edit" || name === "write" || name === "create" || name === "overwrite") {
		return { target: linkedPath(), meta: [] };
	}
	if (name === "bash") {
		const raw = typeof record.command === "string" ? displayText(record.command, presentation) : "";
		const first = raw.split("\n")[0] ?? "";
		return {
			target: styleText(presentation, "toolOutput", raw.includes("\n") ? `${first} …` : first || "…"),
			meta: [],
		};
	}
	if (name === "ls") {
		const meta: string[] = [];
		if (typeof record.glob === "string") meta.push(`glob: ${displayText(record.glob, presentation)}`);
		if (typeof record.limit === "number" || typeof record.limit === "string") {
			meta.push(`limit: ${displayText(String(record.limit), presentation)}`);
		}
		return { target: linkedPath(), meta };
	}
	return { target: "", meta: [] };
}

function styleToolMeta(presentation: RenderPresentation, value: string): string {
	const stats = /^(\+\d+)\s+(−\d+)$/u.exec(value);
	if (!stats) return styleText(presentation, "dim", value);
	return `${styleText(presentation, "toolDiffAdded", stats[1]!)} ${styleText(presentation, "toolDiffRemoved", stats[2]!)}`;
}

function renderToolHeader(
	name: string,
	args: unknown,
	presentation: RenderPresentation,
	context: RenderContextLike,
	options: { phase: ToolPhase; meta?: readonly string[]; expandable?: boolean },
): string {
	const subject = toolSubject(name, args, presentation, context);
	const meta = [...new Set([...subject.meta, ...(options.meta ?? [])].filter((item) => item.length > 0))];
	if (options.expandable) meta.push(EXPAND_KEY);

	if (presentation.mode === "screen-reader") {
		const state = options.phase === "running"
			? "running"
			: options.phase === "error"
				? "failed"
				: options.phase === "noop"
					? "no-op"
					: "complete";
		return `${name} ${state}: ${subject.target}${meta.length > 0 ? `; ${meta.join("; ")}` : ""}`;
	}

	const label = `${toolLabel(presentation.theme, name)}${subject.target ? `  ${subject.target}` : ""}`;
	const marker = phaseMarker(presentation, options.phase);
	const head = marker ? `${marker} ${label}` : label;
	if (meta.length === 0) return head;
	const separator = styleText(presentation, "dim", " · ");
	return `${head}${separator}${meta.map((item) => styleToolMeta(presentation, item)).join(separator)}`;
}

function renderToolCall(
	name: string,
	args: unknown,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
	settings: ReadmapRendererSettings = DEFAULT_READMAP_RENDERER_SETTINGS,
): Component {
	const presentation = resolvePresentation(theme);
	if (name === "write") {
		if (context.isPartial === false) {
			if (context.lastComponent instanceof WriteCallComponent) context.lastComponent.stop();
			return new Text("", 0, 0);
		}
		return reuseOrCreateWriteCall(context.lastComponent, args, presentation, context, settings);
	}
	if (context.isPartial === false) return reuseOrCreateText(context.lastComponent, "");
	return reuseOrCreateText(
		context.lastComponent,
		renderToolHeader(name, args, presentation, context, { phase: "running" }),
	);
}

// ─── result renderers ────────────────────────────────────────────

function warningBadges(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) return [];
	return [`${value.length} warning${value.length === 1 ? "" : "s"}`];
}

function renderToolError(
	name: string,
	body: string,
	options: RenderOptionsLike,
	presentation: RenderPresentation,
	context: RenderContextLike,
	meta: readonly string[] = [],
	collapsedTail = 0,
): Component {
	const [first = `${name} failed`, ...rest] = body.split("\n");
	const expanded = isExpanded(options, context);
	const visibleRest = expanded ? rest : collapsedTail > 0 ? rest.slice(-collapsedTail) : [];
	const hidden = Math.max(0, rest.length - visibleRest.length);
	const header = renderToolHeader(name, context.args, presentation, context, {
		phase: "error",
		meta: [...meta, first || `${name} failed`],
		expandable: hidden > 0,
	});
	if (visibleRest.length === 0) return reuseOrCreateText(context.lastComponent, header);
	return reuseOrCreateWidthAware(context.lastComponent, (width) => [
		header,
		...visibleRest.flatMap((line) => wrapWithHangingIndent(
			presentation.mode === "screen-reader" ? "output: " : styleText(presentation, "error", "┃ "),
			styleText(presentation, "toolOutput", line),
			width,
		)),
		...(hidden > 0 ? [collapsedHint(visibleRest.length, rest.length, "error lines", true, presentation)] : []),
	]);
}

function renderReadResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	if (context.isPartial || options.isPartial) return reuseOrCreateText(context.lastComponent, "");

	const body = textOf(result, p);
	if (context.isError || result.isError) return renderToolError("read", body, options, p, context);

	const details = asRecord(result.details);
	const ptc = asRecord(details?.ptcValue);
	const expanded = isExpanded(options, context);
	const meta: string[] = [];
	if (ptc) {
		const range = asRecord(ptc.range);
		const truncation = asRecord(ptc.truncation);
		const start = typeof range?.startLine === "number" ? range.startLine : 1;
		const end = typeof range?.endLine === "number" ? range.endLine : start;
		const total = typeof range?.totalLines === "number" ? range.totalLines : end;
		const visible = truncation && typeof truncation.outputLines === "number"
			? truncation.outputLines
			: Math.max(0, end - start + 1);
		const word = visible === 1 ? "line" : "lines";
		meta.push(truncation ? `${visible}/${typeof truncation.totalLines === "number" ? truncation.totalLines : total} ${word}` : `${visible} ${word}`);
		if (truncation) meta.push("truncated");
		const symbol = asRecord(ptc.symbol);
		if (symbol && typeof symbol.name === "string") meta.push(`symbol: ${displayText(symbol.name, p)}`);
		else if (typeof ptc.symbol === "string") meta.push(`symbol: ${displayText(ptc.symbol, p)}`);
		if (ptc.map) meta.push("map");
		meta.push(...warningBadges(ptc.warnings));
	} else {
		const count = body.length === 0 ? 0 : body.split("\n").length;
		meta.push(`${count} ${count === 1 ? "line" : "lines"}`);
	}

	const header = renderToolHeader("read", context.args, p, context, {
		phase: "success",
		meta,
		expandable: Boolean(body) && !expanded,
	});
	if (!expanded || !body) return reuseOrCreateText(context.lastComponent, header);
	return reuseOrCreateWidthAware(context.lastComponent, (width) => [header, ...wrapHashlines(body, width, p)]);
}

function renderEditResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	if (context.isPartial || options.isPartial) return reuseOrCreateText(context.lastComponent, "");

	const body = textOf(result, p);
	const details = asRecord(result.details) ?? {};
	const ptc = asRecord(details.ptcValue);
	const expanded = isExpanded(options, context);
	const isError = Boolean(context.isError || result.isError || ptc?.ok === false);
	const noopEdits = Array.isArray(ptc?.noopEdits) ? ptc.noopEdits : [];
	const warnings = warningBadges(ptc?.warnings);
	const semantic = asRecord(ptc?.semanticSummary);
	const classification = typeof semantic?.classification === "string"
		? displayText(semantic.classification, p)
		: undefined;

	if (isError) return renderToolError("edit", body, options, p, context);
	if (noopEdits.length > 0) {
		const header = renderToolHeader("edit", context.args, p, context, {
			phase: "noop",
			meta: ["no-op", classification ?? "", ...warnings],
		});
		return reuseOrCreateText(context.lastComponent, expanded && body ? `${header}\n${styleText(p, "dim", body)}` : header);
	}

	const diffData = isDiffData(details.diffData)
		? details.diffData
		: isDiffData(ptc?.diffData)
			? ptc.diffData
			: undefined;
	const stats = diffData?.stats ?? { added: 0, removed: 0 };
	const header = renderToolHeader("edit", context.args, p, context, {
		phase: "success",
		meta: [`+${stats.added} −${stats.removed}`, classification ?? "", ...warnings],
	});
	if (!diffData) return reuseOrCreateText(context.lastComponent, header);
	return reuseOrCreateDiff(context.lastComponent, {
		prefixLines: [header],
		diffData,
		theme: p.theme,
		expanded,
		presentation: p,
	});
}

function renderWriteResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	if (context.isPartial || options.isPartial) return reuseOrCreateText(context.lastComponent, "");

	const body = textOf(result, p);
	const details = asRecord(result.details) ?? {};
	const ptc = asRecord(details.ptcValue);
	const expanded = isExpanded(options, context);
	const isError = Boolean(context.isError || result.isError || ptc?.ok === false);
	const warnings = warningBadges(ptc?.warnings ?? details.warnings);
	const inputRecord = asRecord(context.args);
	const input = writeInput(context.args);
	const hasArgsContent = typeof inputRecord?.content === "string";
	const ptcLines = Array.isArray(ptc?.lines) ? ptc.lines : [];
	const fallbackContent = ptcLines.map((item) => {
		const row = asRecord(item);
		const raw = typeof row?.raw === "string" ? row.raw : typeof item === "string" ? item : "";
		const hashline = raw.match(HASHLINE_RE);
		return hashline?.[3] ?? raw;
	}).join("\n");
	const content = displayText(hasArgsContent ? input.content : fallbackContent, p);
	const path = displayText(input.path, p);
	const lineCount = content.length === 0 ? 0 : content.split("\n").length;
	const lineMeta = `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;

	const renderPreview = (header: string, errorLines: string[] = []): Component => {
		let cache: WriteHighlightCache | undefined;
		return reuseOrCreateWidthAware(context.lastComponent, (width) => {
			const preview = renderWritePreviewLines(content, path, p, width, expanded, false, cache);
			cache = preview.cache;
			return [
				header,
				...errorLines.flatMap((line) => wrapWithHangingIndent(
					p.mode === "screen-reader" ? "error: " : styleText(p, "error", "┃ "),
					styleText(p, "toolOutput", line),
					width,
				)),
				...preview.lines,
			];
		});
	};

	if (isError) {
		const [first = "write failed", ...rest] = body.split("\n");
		const visibleErrors = expanded ? rest : rest.slice(-2);
		const header = renderToolHeader("write", context.args, p, context, {
			phase: "error",
			meta: [first || "write failed", "not written", lineMeta, ...warnings],
			expandable: !expanded && (content.length > 0 || rest.length > visibleErrors.length),
		});
		return renderPreview(header, visibleErrors);
	}

	const state = details.writeState === "overwritten" ? "overwrite" : "create";
	if (state === "create") {
		const header = renderToolHeader("create", context.args, p, context, {
			phase: "success",
			meta: [lineMeta, ...warnings],
			expandable: content.length > 0 && !expanded,
		});
		return renderPreview(header);
	}

	const diffData = isDiffData(details.diffData)
		? details.diffData
		: isDiffData(ptc?.diffData)
			? ptc.diffData
			: undefined;
	const header = renderToolHeader("overwrite", context.args, p, context, {
		phase: "success",
		meta: [...(diffData ? [`+${diffData.stats.added} −${diffData.stats.removed}`] : [lineMeta]), ...warnings],
		expandable: !diffData && content.length > 0 && !expanded,
	});
	if (!diffData) return renderPreview(header);
	return reuseOrCreateDiff(context.lastComponent, {
		prefixLines: [header],
		diffData,
		theme: p.theme,
		expanded,
		presentation: p,
	});
}

function renderBashResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	if (context.isPartial || options.isPartial) return reuseOrCreateText(context.lastComponent, "");

	const body = textOf(result, p);
	const expanded = isExpanded(options, context);
	const renderOutput = (lines: string[], width: number): string[] => {
		const prefix = p.mode === "screen-reader" ? "output: " : styleText(p, "dim", "│ ");
		return lines.flatMap((line) => wrapWithHangingIndent(prefix, styleText(p, "toolOutput", line), width));
	};
	if (context.isError || result.isError) {
		const details = asRecord(result.details);
		const ptc = asRecord(details?.ptcValue);
		const exitCode = typeof details?.exitCode === "number"
			? details.exitCode
			: typeof ptc?.exitCode === "number"
				? ptc.exitCode
				: undefined;
		return renderToolError("bash", body || "command failed", options, p, context, exitCode === undefined ? [] : [`exit ${exitCode}`], 6);
	}
	if (!body.trim()) {
		return reuseOrCreateText(context.lastComponent, renderToolHeader("bash", context.args, p, context, {
			phase: "success",
			meta: ["no output"],
		}));
	}

	const lines = body.replace(/\n+$/, "").split("\n");
	const lineCount = lines.length;
	const short = lineCount <= BASH_SHORT_MAX_LINES && body.length <= BASH_SHORT_MAX_CHARS;
	const visible = expanded || short ? lines : lines.slice(-BASH_COLLAPSED_PREVIEW_LINES);
	const header = renderToolHeader("bash", context.args, p, context, {
		phase: "success",
		meta: [`${lineCount} ${lineCount === 1 ? "line" : "lines"}`],
		expandable: !expanded && !short,
	});
	return reuseOrCreateWidthAware(context.lastComponent, (width) => [
		header,
		...renderOutput(visible, width),
		...(!expanded && !short && visible.length < lineCount
			? [collapsedHint(visible.length, lineCount, "lines", true, p)]
			: []),
	]);
}

function lsEntryLines(
	entries: unknown[],
	presentation: RenderPresentation,
	width: number,
	maxEntries?: number,
): { lines: string[]; shown: number } {
	const items = entries.flatMap((item) => {
		const entry = asRecord(item);
		if (typeof entry?.name !== "string") return [];
		const name = displayText(entry.name, presentation);
		const isDirectory = entry.type === "dir";
		return [{
			text: `${isDirectory ? "▸" : "·"} ${name}${isDirectory ? "/" : ""}`,
			color: isDirectory ? "accent" : "toolOutput",
		}];
	});
	const visibleItems = maxEntries === undefined
		? items
		: items.slice(0, Math.max(0, Math.floor(maxEntries)));
	if (presentation.mode === "screen-reader") {
		return {
			lines: visibleItems.map((item) => `entry: ${item.text}`),
			shown: visibleItems.length,
		};
	}
	if (visibleItems.length < 2 || width < 100) {
		return {
			lines: visibleItems.map((item) => styleText(presentation, item.color, clampLine(item.text, width))),
			shown: visibleItems.length,
		};
	}

	const gap = 2;
	const columnWidth = Math.max(1, Math.floor((width - gap) / 2));
	const rows = Math.ceil(visibleItems.length / 2);
	const cells = visibleItems.map((item) => styleText(presentation, item.color, truncateToWidth(item.text, columnWidth, "…")));
	const lines: string[] = [];
	for (let row = 0; row < rows; row++) {
		const left = cells[row] ?? "";
		const right = cells[row + rows];
		lines.push(right === undefined ? left : `${padEndVisible(left, columnWidth)}${" ".repeat(gap)}${right}`);
	}
	return { lines, shown: visibleItems.length };
}

function renderLsResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	if (context.isPartial || options.isPartial) return reuseOrCreateText(context.lastComponent, "");

	const body = textOf(result, p);
	const expanded = isExpanded(options, context);
	if (context.isError || result.isError) return renderToolError("ls", body, options, p, context);

	const details = asRecord(result.details);
	const ptc = asRecord(details?.ptcValue);
	const entries = Array.isArray(ptc?.entries) ? ptc.entries : [];
	const outputLines = body ? body.split("\n").filter((line) => line.length > 0) : [];
	const total = typeof ptc?.totalEntries === "number"
		? ptc.totalEntries
		: entries.length > 0
			? entries.length
			: outputLines.length;
	const truncated = Boolean(ptc?.truncated);
	if (total === 0 && entries.length === 0) {
		return reuseOrCreateText(context.lastComponent, renderToolHeader("ls", context.args, p, context, {
			phase: "success",
			meta: ["empty"],
		}));
	}

	return reuseOrCreateWidthAware(context.lastComponent, (width) => {
		let lines: string[];
		let shown: number;
		if (entries.length > 0) {
			const layout = lsEntryLines(entries, p, width, expanded ? undefined : LS_COLLAPSED_PREVIEW_ENTRIES);
			lines = layout.lines;
			shown = layout.shown;
		} else {
			const visibleOutput = expanded ? outputLines : outputLines.slice(0, LS_COLLAPSED_PREVIEW_ENTRIES);
			lines = visibleOutput.map((line) => p.mode === "screen-reader"
				? `entry: ${line}`
				: styleText(p, "toolOutput", line));
			shown = visibleOutput.length;
		}
		const hidden = Math.max(0, total - shown);
		const header = renderToolHeader("ls", context.args, p, context, {
			phase: "success",
			meta: [`${total} ${total === 1 ? "entry" : "entries"}`],
			expandable: !expanded && (hidden > 0 || truncated),
		});
		return [
			header,
			...lines,
			...(hidden > 0 || (!expanded && truncated)
				? [collapsedHint(shown, total, "entries", !expanded, p)]
				: []),
		];
	});
}

// ─── patch ───────────────────────────────────────────────────────

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

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

/** 扫描 event / global payload 中的工具对象。 */
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
