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

/** 本扩展已接管的工具对象标记，保证 reload 幂等。 */
export const READMAP_RENDERER_MARK = Symbol.for("pi-jielumoon.readmap-renderer");

/** 接管 readmap 的常用文件/命令工具；其余 readmap 工具保持原 renderer。 */
export const TARGET_TOOL_NAMES = new Set(["read", "edit", "write", "bash", "ls"]);

const SUMMARY_PREFIX = "↳";
const EXPAND_HINT = " • Ctrl+O to expand";
const HASHLINE_RE = /^(\d+:[0-9a-fA-F]+\|)(.*)$/;
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
	cwd?: string;
	width?: number;
	expanded?: boolean;
	isPartial?: boolean;
	isError?: boolean;
	argsComplete?: boolean;
	executionStarted?: boolean;
	lastComponent?: Component;
	toolCallId?: string;
	state?: unknown;
	invalidate?: () => void;
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

type DiffData = {
	version?: number;
	entries: DiffEntry[];
	stats: { added: number; removed: number; context?: number };
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
 * 保留换行，制表符规范为空格；主题 ANSI 只会在此函数之后由本扩展生成。
 */
function sanitizeTerminalText(value: string): string {
	let safe = "";
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
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
			safe += " ";
			continue;
		}
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue;
		safe += value[index]!;
	}
	return safe;
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

function wrapHashlines(text: string, width: number): string[] {
	const out: string[] = [];
	for (const line of sanitizeTerminalText(text).split("\n")) {
		const match = line.match(HASHLINE_RE);
		if (!match) {
			out.push(...wrapTextWithAnsi(line, width).map((part) => clampLine(part, width)));
			continue;
		}
		const prefix = match[1] ?? "";
		const content = match[2] ?? "";
		out.push(...wrapWithHangingIndent(prefix, content, width));
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
	if (path.length <= max) return path;
	const parts = path.replaceAll("\\", "/").split("/");
	if (parts.length <= 2) return truncateToWidth(path, max);
	let result = parts[parts.length - 1] ?? path;
	for (let i = parts.length - 2; i >= 0; i--) {
		const candidate = `${parts[i]}/${result}`;
		if (candidate.length + 2 > max) break;
		result = candidate;
	}
	return result === path ? truncateToWidth(path, max) : `…/${result}`;
}

function textOf(result: ToolResultLike): string {
	const parts = result.content
		?.filter((item) => item?.type === "text" && typeof item.text === "string")
		.map((item) => item.text);
	return sanitizeTerminalText(parts?.join("\n") ?? "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function summaryLine(summary: string, hidden = false): string {
	return hidden ? `${SUMMARY_PREFIX} ${summary}${EXPAND_HINT}` : `${SUMMARY_PREFIX} ${summary}`;
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

// ─── diff body ───────────────────────────────────────────────────

function isDiffData(value: unknown): value is DiffData {
	const record = asRecord(value);
	if (!record || !Array.isArray(record.entries)) return false;
	const stats = asRecord(record.stats);
	return typeof stats?.added === "number" && typeof stats?.removed === "number";
}

function entryText(entry: DiffEntry): string {
	return "text" in entry ? sanitizeTerminalText(entry.text) : "";
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

function tintEntry(theme: ThemeLike | undefined, entry: DiffEntry, text: string): string {
	if (entry.kind === "add") return themeFg(theme, "success", text);
	if (entry.kind === "remove") return themeFg(theme, "error", text);
	return themeFg(theme, "toolOutput", text);
}

function renderDiffLines(
	diffData: DiffData,
	theme: ThemeLike | undefined,
	width: number,
	expanded: boolean,
): string[] {
	const w = normalizeWidth(width);
	const header = clampLine(
		`${SUMMARY_PREFIX} diff +${diffData.stats.added} -${diffData.stats.removed}`,
		w,
	);
	const compact = w < 50;
	const rows: string[] = [header];
	let shown = 0;
	let totalRenderable = 0;

	for (const entry of diffData.entries) {
		if (entry.kind === "meta") continue;
		if (compact && entry.kind === "context") continue;
		totalRenderable++;
		if (!expanded && shown >= DIFF_COLLAPSED_PREVIEW_LINES) continue;

		const prefix = compact
			? `▌${entryMarker(entry)} ${entryLineNo(entry)} `
			: `▌${entryMarker(entry)} ${entryLineNo(entry)} │ `;
		const body = entryText(entry);
		const wrapped = wrapWithHangingIndent(prefix, body, w);
		for (const line of wrapped) rows.push(tintEntry(theme, entry, line));
		shown++;
	}

	if (!expanded && totalRenderable > shown) {
		const hidden = totalRenderable - shown;
		rows.push(
			clampLine(
				`… (${hidden} more diff ${hidden === 1 ? "line" : "lines"}${EXPAND_HINT})`,
				w,
			),
		);
	}

	return clampLines(rows, w);
}

/** 宽度自适应的 diff 内容组件；不自画外框。 */
export class DiffBodyComponent implements Component {
	private prefixLines: string[];
	private diffData: DiffData;
	private theme: ThemeLike | undefined;
	private expanded: boolean;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(options: {
		prefixLines?: string[];
		diffData: DiffData;
		theme?: ThemeLike;
		expanded?: boolean;
	}) {
		this.prefixLines = options.prefixLines ?? [];
		this.diffData = options.diffData;
		this.theme = options.theme;
		this.expanded = options.expanded ?? true;
	}

	update(options: {
		prefixLines?: string[];
		diffData: DiffData;
		theme?: ThemeLike;
		expanded?: boolean;
	}): void {
		this.prefixLines = options.prefixLines ?? [];
		this.diffData = options.diffData;
		this.theme = options.theme;
		this.expanded = options.expanded ?? true;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const w = normalizeWidth(width);
		if (this.cachedLines && this.cachedWidth === w) return this.cachedLines;
		const lines = [
			...this.prefixLines.flatMap((line) =>
				line.split("\n").map((part) => clampLine(part, w)),
			),
			...renderDiffLines(this.diffData, this.theme, w, this.expanded),
		];
		this.cachedLines = lines;
		this.cachedWidth = w;
		return lines;
	}
}

function reuseOrCreateDiff(
	last: Component | undefined,
	options: {
		prefixLines: string[];
		diffData: DiffData;
		theme?: ThemeLike;
		expanded: boolean;
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
	const record = asRecord(args) ?? {};
	const path = typeof record.path === "string" ? sanitizeTerminalText(record.path) : "";
	const symbol = typeof record.symbol === "string" ? sanitizeTerminalText(record.symbol) : "";
	const cwd = context.cwd;
	let line = toolLabel(theme, "read");
	if (path) {
		const shown = `${shortenPath(path)}${rangeSuffix(record)}`;
		line += ` ${linkPath(themeFg(theme, "accent", shown), path, cwd)}`;
	} else {
		line += ` ${themeFg(theme, "toolOutput", "...")}`;
	}
	if (symbol) line += ` ${themeFg(theme, "dim", `symbol: ${symbol}`)}`;
	return reuseOrCreateText(context.lastComponent, clampLine(line, context.width));
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
	const record = asRecord(args) ?? {};
	const path = typeof record.path === "string" ? sanitizeTerminalText(record.path) : "";
	const n = countEdits(record);
	let line = toolLabel(theme, "edit");
	if (path) {
		line += ` ${linkPath(themeFg(theme, "accent", shortenPath(path)), path, context.cwd)}`;
	} else {
		line += ` ${themeFg(theme, "toolOutput", "...")}`;
	}
	if (n > 0) {
		line += ` ${themeFg(theme, "dim", `${n} ${n === 1 ? "edit" : "edits"}`)}`;
	}
	return reuseOrCreateText(context.lastComponent, clampLine(line, context.width));
}

function renderWriteCall(
	args: unknown,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const record = asRecord(args) ?? {};
	const path = typeof record.path === "string" ? sanitizeTerminalText(record.path) : "";
	const content = typeof record.content === "string" ? record.content : undefined;
	const lines = content === undefined ? 0 : content.split("\n").length;
	let line = toolLabel(theme, "write");
	if (path) {
		line += ` ${linkPath(themeFg(theme, "accent", shortenPath(path)), path, context.cwd)}`;
	} else {
		line += ` ${themeFg(theme, "toolOutput", "...")}`;
	}
	if (content !== undefined) {
		line += ` ${themeFg(theme, "dim", `${lines} ${lines === 1 ? "line" : "lines"}`)}`;
	}
	return reuseOrCreateText(context.lastComponent, clampLine(line, context.width));
}

function renderBashCall(
	args: unknown,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const record = asRecord(args) ?? {};
	const raw = typeof record.command === "string" ? sanitizeTerminalText(record.command) : "";
	const first = raw.split("\n")[0] ?? "";
	const command = raw.includes("\n") ? `${first} …` : first;
	const line = `${toolLabel(theme, "bash")} ${themeFg(theme, "muted", command || "...")}`;
	return reuseOrCreateText(context.lastComponent, clampLine(line, context.width));
}

function renderLsCall(
	args: unknown,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const record = asRecord(args) ?? {};
	const path = typeof record.path === "string" ? sanitizeTerminalText(record.path) : ".";
	const glob = typeof record.glob === "string" ? sanitizeTerminalText(record.glob) : "";
	const limit = record.limit;
	const limitText = typeof limit === "number" || typeof limit === "string" ? sanitizeTerminalText(String(limit)) : undefined;
	let line = `${toolLabel(theme, "ls")} ${linkPath(themeFg(theme, "accent", shortenPath(path)), path, context.cwd)}`;
	if (glob) line += ` ${themeFg(theme, "dim", `glob: ${glob}`)}`;
	if (limitText !== undefined) {
		line += ` ${themeFg(theme, "dim", `limit: ${limitText}`)}`;
	}
	return reuseOrCreateText(context.lastComponent, clampLine(line, context.width));
}

// ─── result renderers ────────────────────────────────────────────

function warningBadges(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) return [];
	return [`${value.length} warning${value.length === 1 ? "" : "s"}`];
}

function renderReadResult(
	result: ToolResultLike,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const width = context.width ?? (options as { width?: number }).width;
	if (context.isPartial || options.isPartial) {
		return new Text(clampLine(summaryLine("pending read"), width), 0, 0);
	}

	const body = textOf(result);
	if (context.isError || result.isError) {
		const first = body.split("\n")[0] || "Error";
		const expanded = isExpanded(options, context);
		const msg = expanded && body ? body : first;
		return new Text(
			clampLines(summaryLine(msg).split("\n"), width).join("\n"),
			0,
			0,
		);
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
		if (symbol && typeof symbol.name === "string") badges.push(`symbol: ${sanitizeTerminalText(symbol.name)}`);
		else if (typeof ptc.symbol === "string") badges.push(`symbol: ${sanitizeTerminalText(ptc.symbol)}`);
		if (ptc.map) badges.push("map");
		badges.push(...warningBadges(ptc.warnings));
	} else {
		const n = body.length === 0 ? 0 : body.split("\n").length;
		badges.push(`loaded ${n} ${n === 1 ? "line" : "lines"}`);
	}

	const summary = summaryLine(badges.join(" • "), Boolean(body) && !expanded);
	if (expanded && body) {
		const lines = [summary, ...wrapHashlines(body, normalizeWidth(width))];
		return new Text(clampLines(lines, width).join("\n"), 0, 0);
	}


	return new Text(clampLine(summary, width), 0, 0);
}

function renderEditResult(
	result: ToolResultLike,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const width = context.width ?? (options as { width?: number }).width;
	if (context.isPartial || options.isPartial) {
		return new Text(clampLine(summaryLine("pending edit"), width), 0, 0);
	}

	const body = textOf(result);
	const details = asRecord(result.details) ?? {};
	const ptc = asRecord(details.ptcValue);
	// 只跟 Pi expanded；视觉策略完全由本扩展管理
	const expanded = isExpanded(options, context);
	const isError = Boolean(context.isError || result.isError || ptc?.ok === false);
	const noopEdits = Array.isArray(ptc?.noopEdits) ? ptc.noopEdits : [];
	const warnings = warningBadges(ptc?.warnings);
	const semantic = asRecord(ptc?.semanticSummary);
	const classification =
		typeof semantic?.classification === "string" ? sanitizeTerminalText(semantic.classification) : undefined;

	if (noopEdits.length > 0 && !isError) {
		const lines = [summaryLine("no-op")];
		if (expanded && body) lines.push(themeFg(theme, "dim", body));
		return new Text(clampLines(lines, width).join("\n"), 0, 0);
	}

	if (isError) {
		const first = body.split("\n")[0] || "edit failed";
		const msg = expanded && body ? body : first;
		return new Text(
			clampLines(summaryLine(msg).split("\n"), width).join("\n"),
			0,
			0,
		);
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
	const summary = summaryLine(badges.join(" • "), Boolean(diffData) && !expanded);

	// 折叠态也给一小段 diff 预览
	if (diffData) {
		return reuseOrCreateDiff(context.lastComponent, {
			prefixLines: [summary],
			diffData,
			theme,
			expanded,
		});
	}

	return new Text(clampLine(summary, width), 0, 0);
}

function renderWriteResult(
	result: ToolResultLike,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const width = context.width ?? (options as { width?: number }).width;
	if (context.isPartial || options.isPartial) {
		return new Text(clampLine(summaryLine("pending write"), width), 0, 0);
	}

	const body = textOf(result);
	const details = asRecord(result.details) ?? {};
	const ptc = asRecord(details.ptcValue);
	// write 同样只跟 Ctrl+O / context.expanded
	const expanded = isExpanded(options, context);
	const isError = Boolean(context.isError || result.isError || ptc?.ok === false);

	if (isError) {
		const first = body.split("\n")[0] || "write failed";
		const msg = expanded && body ? body : first;
		return new Text(
			clampLines(summaryLine(msg).split("\n"), width).join("\n"),
			0,
			0,
		);
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
		const summary = summaryLine(badges.join(" • "), hasContent && !expanded);
		// 默认只摘要；展开才给有限内容预览
		if (!expanded || !hasContent) {
			return new Text(clampLine(summary, width), 0, 0);
		}

		const rawLines = ptcLines.flatMap((item) => {
			const row = asRecord(item);
			if (typeof row?.raw === "string") return [sanitizeTerminalText(row.raw)];
			return typeof item === "string" ? [sanitizeTerminalText(item)] : [];
		});
		const shown = rawLines.slice(0, CONTENT_PREVIEW_MAX_LINES);
		const hidden = rawLines.length - shown.length;
		const contentLines = wrapHashlines(shown.join("\n"), normalizeWidth(width)).map((line) =>
			themeFg(theme, "toolOutput", line),
		);
		const out = [
			summary,
			...contentLines,
			...(hidden > 0
				? [`… (${hidden} more ${hidden === 1 ? "line" : "lines"}${EXPAND_HINT})`]
				: []),
		];
		return new Text(clampLines(out, width).join("\n"), 0, 0);
	}

	const diffData = isDiffData(details.diffData)
		? details.diffData
		: isDiffData(ptc?.diffData)
			? ptc.diffData
			: undefined;
	const badges = [state, ...warnings];
	if (diffData) badges.push(`+${diffData.stats.added} -${diffData.stats.removed}`);
	const summary = summaryLine(badges.join(" • "), Boolean(diffData) && !expanded);

	if (diffData) {
		return reuseOrCreateDiff(context.lastComponent, {
			prefixLines: [summary],
			diffData,
			theme,
			expanded,
		});
	}

	return new Text(clampLine(summary, width), 0, 0);
}

function renderBashResult(
	result: ToolResultLike,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const width = context.width ?? (options as { width?: number }).width;
	if (context.isPartial || options.isPartial) {
		return new Text(clampLine(summaryLine("running"), width), 0, 0);
	}

	const body = textOf(result);
	const expanded = isExpanded(options, context);

	if (context.isError || result.isError) {
		const first = body.split("\n")[0] || "command failed";
		const msg = expanded && body ? body : first;
		return new Text(
			clampLines(
				[summaryLine(msg), ...(expanded && body.includes("\n") ? body.split("\n").slice(1) : [])],
				width,
			).join("\n"),
			0,
			0,
		);
	}

	if (!body.trim()) {
		return new Text(clampLine(summaryLine("command completed (no output)"), width), 0, 0);
	}

	const lines = body.replace(/\n+$/, "").split("\n");
	const lineCount = lines.length;
	const short =
		lineCount <= BASH_SHORT_MAX_LINES && body.length <= BASH_SHORT_MAX_CHARS;
	const summary = summaryLine(
		`${lineCount} ${lineCount === 1 ? "line" : "lines"} returned`,
		!expanded && !short,
	);

	// 短输出整段；长输出折叠态先预览再折叠；expanded 才全文
	if (expanded || short) {
		return new Text(clampLines([summary, ...lines], width).join("\n"), 0, 0);
	}

	const preview = lines.slice(0, BASH_COLLAPSED_PREVIEW_LINES);
	const hidden = lineCount - preview.length;
	const out = [
		summary,
		...preview,
		...(hidden > 0
			? [`… (${hidden} more ${hidden === 1 ? "line" : "lines"}${EXPAND_HINT})`]
			: []),
	];
	return new Text(clampLines(out, width).join("\n"), 0, 0);
}

function lsEntryLines(entries: unknown[], theme: ThemeLike | undefined): string[] {
	return entries.flatMap((item) => {
		const entry = asRecord(item);
		if (typeof entry?.name !== "string") return [];
		const type = entry.type === "dir" ? "▸" : "·";
		const suffix = entry.type === "dir" ? "/" : "";
		return [themeFg(theme, entry.type === "dir" ? "accent" : "toolOutput", `${type} ${sanitizeTerminalText(entry.name)}${suffix}`)];
	});
}

function renderLsResult(
	result: ToolResultLike,
	options: { expanded?: boolean; isPartial?: boolean },
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const width = context.width ?? (options as { width?: number }).width;
	if (context.isPartial || options.isPartial) {
		return new Text(clampLine(summaryLine("listing"), width), 0, 0);
	}

	const body = textOf(result);
	const expanded = isExpanded(options, context);
	if (context.isError || result.isError) {
		const first = body.split("\n")[0] || "ls failed";
		const message = expanded && body ? body : first;
		return new Text(clampLines(summaryLine(message).split("\n"), width).join("\n"), 0, 0);
	}

	const details = asRecord(result.details);
	const ptc = asRecord(details?.ptcValue);
	const entries = Array.isArray(ptc?.entries) ? ptc.entries : [];
	const outputLines = body ? body.split("\n").filter((line) => line.length > 0) : [];
	const total = typeof ptc?.totalEntries === "number" ? ptc.totalEntries : outputLines.length;
	const truncated = Boolean(ptc?.truncated);
	if (total === 0 && entries.length === 0) {
		return new Text(clampLine(summaryLine("empty directory"), width), 0, 0);
	}

	const summary = summaryLine(`${total} ${total === 1 ? "entry" : "entries"} returned`);
	const lines = entries.length > 0 ? lsEntryLines(entries, theme) : outputLines;
	const visible = expanded ? lines : lines.slice(0, LS_COLLAPSED_PREVIEW_ENTRIES);
	const hidden = Math.max(0, total - visible.length);
	const out = [
		summary,
		...visible,
		...(hidden > 0 || (!expanded && truncated)
			? [`… (${hidden > 0 ? `${hidden} more` : "more"} ${hidden === 1 ? "entry" : "entries"}${expanded ? "" : EXPAND_HINT})`]
			: []),
	];
	return new Text(clampLines(out, width).join("\n"), 0, 0);
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
