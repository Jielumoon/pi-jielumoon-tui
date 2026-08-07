import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

const SUMMARY_PREFIX = "↳";
const EXPAND_HINT = " · Ctrl+O to expand";
const HASHLINE_RE = /^(\d+):([0-9a-fA-F]+)\|(.*)$/;
/** 短 bash：不超过此行数时折叠态也整段展示。 */
const BASH_SHORT_MAX_LINES = 12;
const BASH_SHORT_MAX_CHARS = 2_000;
/** 长 bash 折叠态预览行数。 */
const BASH_COLLAPSED_PREVIEW_LINES = 12;
/** write 展开时内容预览上限。 */
const CONTENT_PREVIEW_MAX_LINES = 12;
/** edit/write diff 折叠态最多展示的变更行。 */
const DIFF_COLLAPSED_PREVIEW_LINES = 8;
/** ls 折叠态最多展示的目录条目。 */
const LS_COLLAPSED_PREVIEW_ENTRIES = 12;
const SPLIT_DIFF_MIN_WIDTH = 100;
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
	const hint = `showing ${safeShown} of ${safeTotal} ${unit}${expandable ? EXPAND_HINT : ""}`;
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
			styleText(presentation, "accent", padEndVisible(part.hash, hashWidth)) +
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

function summaryLine(
	summary: string,
	presentation?: RenderPresentation,
	label = "tool",
): string {
	if (presentation?.mode === "screen-reader") return `${label}: ${summary}`;
	return `${SUMMARY_PREFIX} ${summary}`;
}

function toolLabel(theme: ThemeLike | undefined, name: string): string {
	return themeFg(theme, "toolTitle", themeBold(theme, name));
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

// ─── call lines ──────────────────────────────────────────────────

function rangeSuffix(args: Record<string, unknown> | undefined): string {
	const offset = args?.offset;
	const limit = args?.limit;
	if (typeof offset === "number" && typeof limit === "number" && offset > 0 && limit > 0) {
		return `:${offset}-${offset + limit - 1}`;
	}
	return "";
}

function renderReadCall(
	args: unknown,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	const record = asRecord(args) ?? {};
	const path = typeof record.path === "string" ? displayText(record.path, p) : "";
	const symbol = typeof record.symbol === "string" ? displayText(record.symbol, p) : "";
	const cwd = context.cwd;
	let line = p.mode === "screen-reader" ? "read:" : toolLabel(p.theme, "read");
	if (path) {
		const shown = `${shortenPath(path)}${rangeSuffix(record)}`;
		const styled = styleText(p, "accent", shown);
		line += ` ${p.mode === "color" ? linkPath(styled, path, cwd) : styled}`;
	} else {
		line += ` ${styleText(p, "toolOutput", "...")}`;
	}
	if (symbol) line += ` ${styleText(p, "dim", `symbol: ${symbol}`)}`;
	return reuseOrCreateText(context.lastComponent, line);
}

function countEdits(args: Record<string, unknown> | undefined): number {
	const edits = args?.edits;
	if (Array.isArray(edits)) return edits.length;
	if (typeof args?.oldText === "string" || typeof args?.old_text === "string") return 1;
	return 0;
}

function renderEditCall(
	args: unknown,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	const record = asRecord(args) ?? {};
	const path = typeof record.path === "string" ? displayText(record.path, p) : "";
	const n = countEdits(record);
	let line = p.mode === "screen-reader" ? "edit:" : toolLabel(p.theme, "edit");
	if (path) {
		const styled = styleText(p, "accent", shortenPath(path));
		line += ` ${p.mode === "color" ? linkPath(styled, path, context.cwd) : styled}`;
	} else {
		line += ` ${styleText(p, "toolOutput", "...")}`;
	}
	if (n > 0) line += ` ${styleText(p, "dim", `${n} ${n === 1 ? "edit" : "edits"}`)}`;
	return reuseOrCreateText(context.lastComponent, line);
}

function renderWriteCall(
	args: unknown,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	const record = asRecord(args) ?? {};
	const path = typeof record.path === "string" ? displayText(record.path, p) : "";
	const content = typeof record.content === "string" ? displayText(record.content, p) : undefined;
	const lines = content === undefined ? 0 : content.split("\n").length;
	let line = p.mode === "screen-reader" ? "write:" : toolLabel(p.theme, "write");
	if (path) {
		const styled = styleText(p, "accent", shortenPath(path));
		line += ` ${p.mode === "color" ? linkPath(styled, path, context.cwd) : styled}`;
	} else {
		line += ` ${styleText(p, "toolOutput", "...")}`;
	}
	if (content !== undefined) line += ` ${styleText(p, "dim", `${lines} ${lines === 1 ? "line" : "lines"}`)}`;
	return reuseOrCreateText(context.lastComponent, line);
}

function renderBashCall(
	args: unknown,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	const record = asRecord(args) ?? {};
	const raw = typeof record.command === "string" ? displayText(record.command, p) : "";
	const first = raw.split("\n")[0] ?? "";
	const command = raw.includes("\n") ? `${first} …` : first;
	const line = p.mode === "screen-reader"
		? `bash: ${command || "..."}`
		: `${toolLabel(p.theme, "bash")} ${styleText(p, "muted", command || "...")}`;
	return reuseOrCreateText(context.lastComponent, line);
}

function renderLsCall(
	args: unknown,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	const record = asRecord(args) ?? {};
	const path = typeof record.path === "string" ? displayText(record.path, p) : ".";
	const glob = typeof record.glob === "string" ? displayText(record.glob, p) : "";
	const limit = record.limit;
	const limitText = typeof limit === "number" || typeof limit === "string" ? displayText(String(limit), p) : undefined;
	let line = p.mode === "screen-reader" ? "ls:" : toolLabel(p.theme, "ls");
	const styled = styleText(p, "accent", shortenPath(path));
	line += ` ${p.mode === "color" ? linkPath(styled, path, context.cwd) : styled}`;
	if (glob) line += ` ${styleText(p, "dim", `glob: ${glob}`)}`;
	if (limitText !== undefined) line += ` ${styleText(p, "dim", `limit: ${limitText}`)}`;
	return reuseOrCreateText(context.lastComponent, line);
}

// ─── result renderers ────────────────────────────────────────────

function warningBadges(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) return [];
	return [`${value.length} warning${value.length === 1 ? "" : "s"}`];
}

function renderReadResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	if (context.isPartial || options.isPartial) {
		return new Text(summaryLine("pending read", p, "read"), 0, 0);
	}

	const body = textOf(result, p);
	if (context.isError || result.isError) {
		const first = body.split("\n")[0] || "Error";
		const expanded = isExpanded(options, context);
		return new Text(summaryLine(expanded && body ? body : first, p, "read"), 0, 0);
	}

	const details = asRecord(result.details);
	const ptc = asRecord(details?.ptcValue);
	const expanded = isExpanded(options, context);
	const badges: string[] = [];

	if (ptc) {
		const range = asRecord(ptc.range);
		const truncation = asRecord(ptc.truncation);
		const start = typeof range?.startLine === "number" ? range.startLine : 1;
		const end = typeof range?.endLine === "number" ? range.endLine : start;
		const total = typeof range?.totalLines === "number" ? range.totalLines : end;
		const visible =
			truncation && typeof truncation.outputLines === "number"
				? truncation.outputLines
				: Math.max(0, end - start + 1);
		const truncated = Boolean(truncation);
		const word = visible === 1 ? "line" : "lines";
		badges.push(
			truncated
				? `loaded ${visible} of ${typeof truncation?.totalLines === "number" ? truncation.totalLines : total} ${word} (truncated)`
				: `loaded ${visible} ${word}`,
		);
		const symbol = asRecord(ptc.symbol);
		if (symbol && typeof symbol.name === "string") badges.push(`symbol: ${displayText(symbol.name, p)}`);
		else if (typeof ptc.symbol === "string") badges.push(`symbol: ${displayText(ptc.symbol, p)}`);
		if (ptc.map) badges.push("map");
		badges.push(...warningBadges(ptc.warnings));
	} else {
		const count = body.length === 0 ? 0 : body.split("\n").length;
		badges.push(`loaded ${count} ${count === 1 ? "line" : "lines"}`);
	}

	const summary = summaryLine(badges.join(" • "), p, "read");
	if (expanded && body) {
		return reuseOrCreateWidthAware(context.lastComponent, (width) => [
			summary,
			...wrapHashlines(body, width, p),
		]);
	}
	if (body) {
		const lineCount = body.split("\n").length;
		return new Text([summary, collapsedHint(0, lineCount, "lines", true, p)].join("\n"), 0, 0);
	}
	return new Text(summary, 0, 0);
}

function renderEditResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	if (context.isPartial || options.isPartial) {
		return new Text(summaryLine("pending edit", p, "edit"), 0, 0);
	}

	const body = textOf(result, p);
	const details = asRecord(result.details) ?? {};
	const ptc = asRecord(details.ptcValue);
	const expanded = isExpanded(options, context);
	const isError = Boolean(context.isError || result.isError || ptc?.ok === false);
	const noopEdits = Array.isArray(ptc?.noopEdits) ? ptc.noopEdits : [];
	const warnings = warningBadges(ptc?.warnings);
	const semantic = asRecord(ptc?.semanticSummary);
	const classification =
		typeof semantic?.classification === "string" ? displayText(semantic.classification, p) : undefined;

	if (noopEdits.length > 0 && !isError) {
		const lines = [summaryLine("no-op", p, "edit")];
		if (expanded && body) lines.push(styleText(p, "dim", body));
		return new Text(lines.join("\n"), 0, 0);
	}

	if (isError) {
		const first = body.split("\n")[0] || "edit failed";
		const msg = expanded && body ? body : first;
		return new Text(summaryLine(msg, p, "edit"), 0, 0);
	}

	const diffData = isDiffData(details.diffData)
		? details.diffData
		: isDiffData(ptc?.diffData)
			? ptc.diffData
			: undefined;
	const stats = diffData?.stats ?? { added: 0, removed: 0 };
	const badges = [`edited +${stats.added} -${stats.removed}`];
	if (classification) badges.push(classification);
	badges.push(...warnings);
	const summary = summaryLine(badges.join(" • "), p, "edit");

	if (diffData) {
		return reuseOrCreateDiff(context.lastComponent, {
			prefixLines: [summary],
			diffData,
			theme: p.theme,
			expanded,
			presentation: p,
		});
	}

	return new Text(summary, 0, 0);
}

function renderWriteResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	if (context.isPartial || options.isPartial) {
		return new Text(summaryLine("pending write", p, "write"), 0, 0);
	}

	const body = textOf(result, p);
	const details = asRecord(result.details) ?? {};
	const ptc = asRecord(details.ptcValue);
	const expanded = isExpanded(options, context);
	const isError = Boolean(context.isError || result.isError || ptc?.ok === false);

	if (isError) {
		const first = body.split("\n")[0] || "write failed";
		return new Text(summaryLine(expanded && body ? body : first, p, "write"), 0, 0);
	}

	const state = details.writeState === "overwritten" ? "overwritten" : "created";
	const warnings = warningBadges(ptc?.warnings ?? details.warnings);

	if (state === "created") {
		const ptcLines = Array.isArray(ptc?.lines) ? ptc.lines : [];
		const lineCount = ptcLines.length;
		const hasContent = lineCount > 0;
		const badges = [
			state,
			...(hasContent ? [`${lineCount} ${lineCount === 1 ? "line" : "lines"}`] : []),
			...warnings,
		];
		const summary = summaryLine(badges.join(" • "), p, "write");
		if (!expanded || !hasContent) {
			const lines = hasContent && !expanded
				? [summary, collapsedHint(0, lineCount, "lines", true, p)]
				: [summary];
			return new Text(lines.join("\n"), 0, 0);
		}

		const rawLines = ptcLines.flatMap((item) => {
			const row = asRecord(item);
			if (typeof row?.raw === "string") return [displayText(row.raw, p)];
			return typeof item === "string" ? [displayText(item, p)] : [];
		});
		const shown = rawLines.slice(0, CONTENT_PREVIEW_MAX_LINES);
		const hidden = rawLines.length - shown.length;
		return reuseOrCreateWidthAware(context.lastComponent, (width) => [
			summary,
			...wrapHashlines(shown.join("\n"), width, p),
			...(hidden > 0 ? [collapsedHint(shown.length, lineCount, "lines", false, p)] : []),
		]);
	}

	const diffData = isDiffData(details.diffData)
		? details.diffData
		: isDiffData(ptc?.diffData)
			? ptc.diffData
			: undefined;
	const badges = [state, ...warnings];
	if (diffData) badges.push(`+${diffData.stats.added} -${diffData.stats.removed}`);
	const summary = summaryLine(badges.join(" • "), p, "write");

	if (diffData) {
		return reuseOrCreateDiff(context.lastComponent, {
			prefixLines: [summary],
			diffData,
			theme: p.theme,
			expanded,
			presentation: p,
		});
	}

	return new Text(summary, 0, 0);
}

function renderBashResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	if (context.isPartial || options.isPartial) {
		return new Text(summaryLine("running", p, "bash"), 0, 0);
	}

	const body = textOf(result, p);
	const expanded = isExpanded(options, context);
	const renderOutput = (lines: string[], width: number): string[] => {
		const prefix = p.mode === "screen-reader" ? "output: " : styleText(p, "dim", "│ ");
		return lines.flatMap((line) =>
			wrapWithHangingIndent(prefix, styleText(p, "toolOutput", line), width),
		);
	};

	if (context.isError || result.isError) {
		const [first = "command failed", ...rest] = body.split("\n");
		const summary = summaryLine(first || "command failed", p, "bash");
		if (!expanded || rest.length === 0) return new Text(summary, 0, 0);
		return reuseOrCreateWidthAware(context.lastComponent, (width) => [
			summary,
			...renderOutput(rest, width),
		]);
	}

	if (!body.trim()) {
		return new Text(summaryLine("command completed (no output)", p, "bash"), 0, 0);
	}

	const lines = body.replace(/\n+$/, "").split("\n");
	const lineCount = lines.length;
	const summary = summaryLine(
		`${lineCount} ${lineCount === 1 ? "line" : "lines"} returned`,
		p,
		"bash",
	);
	const short = lineCount <= BASH_SHORT_MAX_LINES && body.length <= BASH_SHORT_MAX_CHARS;
	const visible = expanded || short ? lines : lines.slice(0, BASH_COLLAPSED_PREVIEW_LINES);
	return reuseOrCreateWidthAware(context.lastComponent, (width) => [
		summary,
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
	if (context.isPartial || options.isPartial) {
		return new Text(summaryLine("listing", p, "ls"), 0, 0);
	}

	const body = textOf(result, p);
	const expanded = isExpanded(options, context);
	if (context.isError || result.isError) {
		const first = body.split("\n")[0] || "ls failed";
		return new Text(summaryLine(expanded && body ? body : first, p, "ls"), 0, 0);
	}

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
		return new Text(summaryLine("empty directory", p, "ls"), 0, 0);
	}

	const summary = summaryLine(`${total} ${total === 1 ? "entry" : "entries"} returned`, p, "ls");
	return reuseOrCreateWidthAware(context.lastComponent, (width) => {
		let lines: string[];
		let shown: number;
		if (entries.length > 0) {
			const layout = lsEntryLines(
				entries,
				p,
				width,
				expanded ? undefined : LS_COLLAPSED_PREVIEW_ENTRIES,
			);
			lines = layout.lines;
			shown = layout.shown;
		} else {
			const visibleOutput = expanded
				? outputLines
				: outputLines.slice(0, LS_COLLAPSED_PREVIEW_ENTRIES);
			lines = visibleOutput.map((line) => p.mode === "screen-reader"
				? `entry: ${line}`
				: styleText(p, "toolOutput", line));
			shown = visibleOutput.length;
		}
		const hidden = Math.max(0, total - shown);
		return [
			summary,
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
export function patchReadmapTool(tool: unknown): boolean {
	if (!isObject(tool)) return false;
	const target = tool as PatchableTool;
	const name = toolNameOf(target);
	if (!name || !TARGET_TOOL_NAMES.has(name)) return false;
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
			switch (name) {
				case "read":
					return renderReadCall(args, t, context);
				case "edit":
					return renderEditCall(args, t, context);
				case "write":
					return renderWriteCall(args, t, context);
				case "bash":
					return renderBashCall(args, t, context);

				case "ls":
					return renderLsCall(args, t, context);
				default:
					return safeCallOriginal(originals.renderCall, [args, theme, context])
						?? new Text(name, 0, 0);
			}
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
				?? new Text(summaryLine("render error"), 0, 0)
			);
		}
	};

	target.renderCall = renderCall as PatchableTool["renderCall"];
	target.renderResult = renderResult as PatchableTool["renderResult"];
	Object.defineProperty(target, READMAP_RENDERER_MARK, {
		value: true,
		configurable: true,
		enumerable: false,
		writable: false,
	});
	return true;
}

/** 扫描 event / global payload 中的工具对象。 */
export function patchToolPayload(payload: unknown): string[] {
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
		if (patchReadmapTool(tool)) patched.push(name);
	}
	return patched;
}

function patchGlobalExecutors(): string[] {
	const global = globalThis as GlobalWithHashline;
	return patchToolPayload(global.__hashlineToolExecutors);
}

/** 观察后续 registerTool（含 bash）；幂等，扩展生命周期内保持。 */
function installRegisterToolObserver(pi: ExtensionAPI): void {
	const tagged = pi as PiWithRegisterInterceptor;
	if (tagged[REGISTER_TOOL_INTERCEPTOR]?.wrapped === pi.registerTool) return;

	// 始终包当前函数：其它扩展重载后再 /reload，不会跳过新拦截器。
	const original = pi.registerTool.bind(pi);
	const wrapped: ExtensionAPI["registerTool"] = ((tool) => {
		original(tool);
		try {
			patchReadmapTool(tool);
		} catch {
			// renderer patch 失败不能影响工具注册
		}
	}) as ExtensionAPI["registerTool"];
	pi.registerTool = wrapped;
	tagged[REGISTER_TOOL_INTERCEPTOR] = { wrapped };
}

/**
 * 安装 readmap 工具可视化接管。
 * event/global 路径可靠覆盖 read/edit/write；bash 仅在本扩展先于它注册时可接管。
 * 只替换 renderCall/renderResult；execute 与参数 schema 保持原引用。
 */
export default function installReadmapRenderers(pi: ExtensionAPI): void {
	const boot = () => {
		try {
			patchGlobalExecutors();
		} catch {
			// quiet degrade
		}
	};

	try {
		pi.events.on("hashline:tool-executors", (payload) => {
			try {
				patchToolPayload(payload);
			} catch {
				// quiet degrade
			}
		});
	} catch {
		// events bus unavailable
	}

	try {
		installRegisterToolObserver(pi);
	} catch {
		// registerTool not writable
	}

	boot();
	pi.on("session_start", boot);
	pi.on("before_agent_start", boot);
}
