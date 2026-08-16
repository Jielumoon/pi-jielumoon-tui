/** read / edit / write / bash / ls / grep / find 的调用行与结果渲染；只产内容，不画外框。 */

import { truncateToWidth, Text, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { asRecord } from "../guards.ts";
import { reuseOrCreateText, reuseOrCreateWidthAware } from "./components.ts";
import { isDiffData, reuseOrCreateDiff } from "./diff.ts";
import { EditCallComponent, reuseOrCreateEditCall } from "./edit-stream.ts";
import { formatLineRange, renderToolHeader } from "./header.ts";
import {
	asThemeLike,
	clampLine,
	collapsedHint,
	displayText,
	padEndVisible,
	padStartVisible,
	resolvePresentation,
	styleText,
	wrapWithHangingIndent,
	type RenderPresentation,
	type ThemeLike,
} from "./presentation.ts";
import {
	DEFAULT_READMAP_RENDERER_SETTINGS,
	type ReadmapRendererSettings,
	type RenderContextLike,
	type RenderOptionsLike,
	type ToolResultLike,
} from "./types.ts";
import {
	renderWritePreviewLines,
	reuseOrCreateWriteCall,
	WriteCallComponent,
	writeInput,
	type WriteHighlightCache,
} from "./write-stream.ts";

const HASHLINE_RE = /^(\d+):([0-9a-fA-F]+)\|(.*)$/;
/** 短 bash：不超过此行数时折叠态也整段展示。 */
const BASH_SHORT_MAX_LINES = 4;
const BASH_SHORT_MAX_CHARS = 2_000;
/** 长 bash 折叠态预览行数。 */
const BASH_COLLAPSED_PREVIEW_LINES = 4;
/** ls 折叠态最多展示的目录条目。 */
const LS_COLLAPSED_PREVIEW_ENTRIES = 8;
/** grep 折叠态最多展示的匹配数（文件分组行不计入）。 */
const GREP_COLLAPSED_PREVIEW_MATCHES = 6;
/** find 折叠态最多展示的结果条目。 */
const FIND_COLLAPSED_PREVIEW_ENTRIES = 8;

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

function isExpanded(
	options: { expanded?: boolean } | undefined,
	context: RenderContextLike | undefined,
): boolean {
	return context?.expanded ?? options?.expanded ?? false;
}

export function renderToolCall(
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
	if (name === "edit") {
		if (context.isPartial === false) {
			if (context.lastComponent instanceof EditCallComponent) context.lastComponent.stop();
			return new Text("", 0, 0);
		}
		return reuseOrCreateEditCall(context.lastComponent, args, presentation, context, settings);
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

export function renderReadResult(
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
		const startLine = typeof range?.startLine === "number" ? range.startLine : undefined;
		const endLine = typeof range?.endLine === "number" ? range.endLine : undefined;
		const start = startLine ?? 1;
		const end = endLine ?? start;
		const total = typeof range?.totalLines === "number" ? range.totalLines : end;
		const visible = truncation && typeof truncation.outputLines === "number"
			? truncation.outputLines
			: Math.max(0, end - start + 1);
		const word = visible === 1 ? "line" : "lines";
		if (startLine !== undefined && endLine !== undefined) {
			meta.push(formatLineRange({ start: startLine, end: endLine }));
		}
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

export function renderEditResult(
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

export function renderWriteResult(
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

export function renderBashResult(
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

export function renderLsResult(
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

// ─── grep / find ─────────────────────────────────────────────────

/** grep / find 把截断提示以 `\n\n[...]` 追加在正文尾部；剥离后只保留 meta 徽章。 */
function stripTrailingNotice(body: string): string {
	const match = /\n\n\[[^\n]*\]$/.exec(body);
	return match ? body.slice(0, match.index) : body;
}

type GrepRow = { kind: "match" | "context"; file: string; lineNo: string; text: string }
	| { kind: "plain"; text: string };

const GREP_MATCH_LINE_RE = /^(.+?):(\d+): (.*)$/;
const GREP_CONTEXT_LINE_RE = /^(.+?)-(\d+)- (.*)$/;

/** 解析 `path:12: text`（匹配）与 `path-12- text`（上下文）；双双命中时取分隔符更靠前者。 */
function parseGrepRow(line: string): GrepRow {
	const match = GREP_MATCH_LINE_RE.exec(line);
	const context = GREP_CONTEXT_LINE_RE.exec(line);
	if (match && (!context || match[1]!.length <= context[1]!.length)) {
		return { kind: "match", file: match[1]!, lineNo: match[2]!, text: match[3]! };
	}
	if (context) {
		return { kind: "context", file: context[1]!, lineNo: context[2]!, text: context[3]! };
	}
	return { kind: "plain", text: line };
}

function escapeRegExpLiteral(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 匹配词高亮用的 JS 正则。rg 的 DFA 引擎没有回溯，而 `(a+)+` 这类嵌套量词在
 * JS 回溯引擎上可能指数爆炸，保守启发式命中时直接放弃高亮（只降级、不冒险）。
 */
function grepHighlightRegex(args: unknown): RegExp | undefined {
	const record = asRecord(args);
	const pattern = typeof record?.pattern === "string" ? record.pattern : "";
	if (pattern.length === 0 || pattern.length > 200) return undefined;
	const source = record?.literal === true ? escapeRegExpLiteral(pattern) : pattern;
	if (record?.literal !== true && /[+*?}][)\]]*[+*{]/.test(source)) return undefined;
	try {
		return new RegExp(source, record?.ignoreCase === true ? "gi" : "g");
	} catch {
		return undefined;
	}
}

function highlightGrepText(
	text: string,
	highlight: RegExp | undefined,
	presentation: RenderPresentation,
): string {
	if (!highlight || presentation.mode !== "color" || text.length === 0) {
		return styleText(presentation, "toolOutput", text);
	}
	let out = "";
	let cursor = 0;
	try {
		highlight.lastIndex = 0;
		for (const found of text.matchAll(highlight)) {
			const hit = found[0] ?? "";
			if (hit.length === 0) continue;
			const index = found.index ?? 0;
			if (index > cursor) out += styleText(presentation, "toolOutput", text.slice(cursor, index));
			out += styleText(presentation, "accent", hit);
			cursor = index + hit.length;
		}
	} catch {
		return styleText(presentation, "toolOutput", text);
	}
	if (cursor === 0) return styleText(presentation, "toolOutput", text);
	if (cursor < text.length) out += styleText(presentation, "toolOutput", text.slice(cursor));
	return out;
}

export function renderGrepResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	if (context.isPartial || options.isPartial) return reuseOrCreateText(context.lastComponent, "");

	const rawBody = textOf(result, p);
	if (context.isError || result.isError) return renderToolError("grep", rawBody, options, p, context);

	const details = asRecord(result.details);
	const truncated = Boolean(details?.matchLimitReached)
		|| Boolean(asRecord(details?.truncation)?.truncated)
		|| Boolean(details?.linesTruncated);
	const body = stripTrailingNotice(rawBody).replace(/\n+$/, "");
	const lines = body.length === 0 ? [] : body.split("\n").filter((line) => line.length > 0);
	if (lines.length === 0 || body.trim() === "No matches found") {
		return reuseOrCreateText(context.lastComponent, renderToolHeader("grep", context.args, p, context, {
			phase: "success",
			meta: ["no matches"],
		}));
	}

	const rows = lines.map(parseGrepRow);
	const matchTotal = rows.filter((row) => row.kind === "match").length;
	const fileTotal = new Set(
		rows.flatMap((row) => (row.kind === "plain" ? [] : [row.file])),
	).size;
	const expanded = isExpanded(options, context);

	// 折叠按匹配数截断：第 N+1 个匹配（及其后续行）不再展示，前置上下文随其匹配一起隐藏。
	let visibleRows = rows;
	let shownMatches = matchTotal;
	if (!expanded && matchTotal > GREP_COLLAPSED_PREVIEW_MATCHES) {
		let seen = 0;
		let cut = rows.length;
		for (const [index, row] of rows.entries()) {
			if (row.kind !== "match") continue;
			seen += 1;
			if (seen > GREP_COLLAPSED_PREVIEW_MATCHES) {
				cut = index;
				break;
			}
		}
		visibleRows = rows.slice(0, cut);
		shownMatches = GREP_COLLAPSED_PREVIEW_MATCHES;
	}
	const hiddenMatches = matchTotal - shownMatches;

	const meta = [
		`${matchTotal} ${matchTotal === 1 ? "match" : "matches"}`,
		...(fileTotal > 1 ? [`${fileTotal} files`] : []),
		...(truncated ? ["truncated"] : []),
	];
	const header = renderToolHeader("grep", context.args, p, context, {
		phase: "success",
		meta,
		expandable: !expanded && (hiddenMatches > 0 || truncated),
	});
	const highlight = grepHighlightRegex(context.args);
	const lineNoWidth = rows.reduce(
		(max, row) => (row.kind === "plain" ? max : Math.max(max, visibleWidth(row.lineNo))),
		1,
	);

	return reuseOrCreateWidthAware(context.lastComponent, (width) => {
		const out: string[] = [header];
		let currentFile: string | undefined;
		for (const row of visibleRows) {
			if (row.kind === "plain") {
				out.push(p.mode === "screen-reader"
					? `output: ${row.text}`
					: clampLine(styleText(p, "toolOutput", row.text), width));
				continue;
			}
			if (p.mode === "screen-reader") {
				out.push(`${row.kind}: ${row.file}:${row.lineNo}: ${row.text}`);
				continue;
			}
			if (row.file !== currentFile) {
				currentFile = row.file;
				out.push(clampLine(styleText(p, "syntaxType", row.file), width));
			}
			const prefix = `  ${styleText(p, "dim", padStartVisible(row.lineNo, lineNoWidth))}${styleText(p, "muted", row.kind === "match" ? ":" : "·")} `;
			const content = row.kind === "match"
				? highlightGrepText(row.text, highlight, p)
				: styleText(p, "dim", row.text);
			out.push(...wrapWithHangingIndent(prefix, content, width));
		}
		if (hiddenMatches > 0 || (!expanded && truncated)) {
			out.push(collapsedHint(shownMatches, matchTotal, "matches", !expanded, p));
		}
		return out;
	});
}

export function renderFindResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const p = resolvePresentation(theme);
	if (context.isPartial || options.isPartial) return reuseOrCreateText(context.lastComponent, "");

	const rawBody = textOf(result, p);
	if (context.isError || result.isError) return renderToolError("find", rawBody, options, p, context);

	const details = asRecord(result.details);
	const truncated = Boolean(details?.resultLimitReached)
		|| Boolean(asRecord(details?.truncation)?.truncated);
	const body = stripTrailingNotice(rawBody).replace(/\n+$/, "");
	const paths = body.length === 0 ? [] : body.split("\n").filter((line) => line.length > 0);
	if (paths.length === 0 || body.trim() === "No files found matching pattern") {
		return reuseOrCreateText(context.lastComponent, renderToolHeader("find", context.args, p, context, {
			phase: "success",
			meta: ["no files"],
		}));
	}

	const expanded = isExpanded(options, context);
	// find 输出目录带尾随 `/`；映射成 ls 条目复用同一套双列排版。
	const entries = paths.map((path) => ({
		name: path.endsWith("/") ? path.slice(0, -1) : path,
		type: path.endsWith("/") ? "dir" : "file",
	}));
	const total = entries.length;

	return reuseOrCreateWidthAware(context.lastComponent, (width) => {
		const layout = lsEntryLines(entries, p, width, expanded ? undefined : FIND_COLLAPSED_PREVIEW_ENTRIES);
		const hidden = Math.max(0, total - layout.shown);
		const header = renderToolHeader("find", context.args, p, context, {
			phase: "success",
			meta: [
				`${total} ${total === 1 ? "result" : "results"}`,
				...(truncated ? ["truncated"] : []),
			],
			expandable: !expanded && (hidden > 0 || truncated),
		});
		return [
			header,
			...layout.lines,
			...(hidden > 0 || (!expanded && truncated)
				? [collapsedHint(layout.shown, total, "results", !expanded, p)]
				: []),
		];
	});
}
