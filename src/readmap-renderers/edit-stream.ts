/**
 * Edit 参数流的伪 diff 逐字动画：操作标签行 + 红 `-` / 绿 `+` 尾部预览。
 * 流式期间只有锚点与 old/new 文本，没有真实行号；完成后由 renderEditResult 的真 diff 替换。
 */

import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { asRecord } from "../guards.ts";
import { renderToolHeader } from "./header.ts";
import {
	clampLines,
	displayText,
	normalizeWidth,
	styleText,
	wrapWithHangingIndent,
	type RenderPresentation,
} from "./presentation.ts";
import {
	advanceStreamReveal,
	commonPrefixBoundary,
	scheduleStreamAnimation,
	trailingTextByWidth,
	unscheduleStreamAnimation,
} from "./stream-animation.ts";
import type { ReadmapRendererSettings, RenderContextLike } from "./types.ts";

/** edit 折叠态固定保留的终端显示行。 */
export const EDIT_COLLAPSED_DISPLAY_LINES = 8;

export type EditStreamKind = "label" | "remove" | "add";
export type EditStreamLine = { kind: EditStreamKind; text: string };

type EditStreamOp = { label: string; removed?: string; added?: string };

function textOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** 锚点/符号来自模型输出，净化后压成单行，避免破坏行对齐；个别模型把锚点发成数字。 */
function labelPart(value: unknown, presentation: RenderPresentation): string {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return typeof value === "string" && value.length > 0
		? displayText(value, presentation).replaceAll("\n", " ")
		: "";
}

function labelSuffix(value: unknown, presentation: RenderPresentation): string {
	const text = labelPart(value, presentation);
	return text.length > 0 ? ` @ ${text}` : "";
}

function editStreamOp(
	edit: Record<string, unknown>,
	presentation: RenderPresentation,
): EditStreamOp | undefined {
	const setLine = asRecord(edit.set_line);
	if (setLine) {
		return {
			label: `set_line${labelSuffix(setLine.anchor, presentation)}`,
			added: textOrUndefined(setLine.new_text),
		};
	}
	const replaceLines = asRecord(edit.replace_lines);
	if (replaceLines) {
		const start = labelSuffix(replaceLines.start_anchor, presentation);
		const end = labelPart(replaceLines.end_anchor, presentation);
		return {
			label: `replace_lines${start}${end.length > 0 ? `–${end}` : ""}`,
			added: textOrUndefined(replaceLines.new_text),
		};
	}
	const insertAfter = asRecord(edit.insert_after);
	if (insertAfter) {
		return {
			label: `insert_after${labelSuffix(insertAfter.anchor, presentation)}`,
			added: textOrUndefined(insertAfter.new_text) ?? textOrUndefined(insertAfter.text),
		};
	}
	// 不把 all/fuzzy 放进标签：这些键在 new_text 之后才到，中途改写标签会让已揭示内容回退重放。
	const replace = asRecord(edit.replace);
	if (replace) {
		return {
			label: "replace",
			removed: textOrUndefined(replace.old_text),
			added: textOrUndefined(replace.new_text),
		};
	}
	const replaceSymbol = asRecord(edit.replace_symbol);
	if (replaceSymbol) {
		return {
			label: `replace_symbol${labelSuffix(replaceSymbol.symbol, presentation)}`,
			added: textOrUndefined(replaceSymbol.new_body),
		};
	}
	// 宿主 pi 风格与 readmap 遗留顶层字段：都当作 replace 展示。
	if (typeof edit.oldText === "string" || typeof edit.newText === "string") {
		return {
			label: "replace",
			removed: textOrUndefined(edit.oldText),
			added: textOrUndefined(edit.newText),
		};
	}
	if (typeof edit.old_text === "string" || typeof edit.new_text === "string") {
		return {
			label: "replace",
			removed: textOrUndefined(edit.old_text),
			added: textOrUndefined(edit.new_text),
		};
	}
	return undefined;
}

function pushTextLines(
	lines: EditStreamLine[],
	kind: EditStreamKind,
	value: string | undefined,
	presentation: RenderPresentation,
): void {
	if (value === undefined) return;
	for (const line of displayText(value, presentation).split("\n")) {
		lines.push({ kind, text: line });
	}
}

/**
 * 把（可能不完整的）edit 参数扁平化为带样式类别的逻辑行序列。
 * `edits` 是字符串（个别模型把数组发成 JSON 文本）时不做展示，等结果态兜底。
 */
export function editStreamInput(
	args: unknown,
	presentation: RenderPresentation,
): { path: string; editCount: number; lines: EditStreamLine[] } {
	const record = asRecord(args);
	const path = typeof record?.path === "string" ? record.path : "";
	const ops: EditStreamOp[] = [];
	if (Array.isArray(record?.edits)) {
		for (const item of record.edits) {
			const edit = asRecord(item);
			if (!edit) continue;
			const op = editStreamOp(edit, presentation);
			if (op) ops.push(op);
		}
	} else if (record) {
		// readmap 会把顶层 old_text/new_text 归一化为 edits[0].replace；流式早期先按单条展示。
		const legacy = editStreamOp(record, presentation);
		if (legacy) ops.push(legacy);
	}
	const lines: EditStreamLine[] = [];
	for (const op of ops) {
		lines.push({ kind: "label", text: op.label });
		pushTextLines(lines, "remove", op.removed, presentation);
		pushTextLines(lines, "add", op.added, presentation);
	}
	return { path, editCount: ops.length, lines };
}

function editLineColor(kind: EditStreamKind): string {
	return kind === "label" ? "muted" : kind === "remove" ? "toolDiffRemoved" : "toolDiffAdded";
}

function editLinePrefix(kind: EditStreamKind, presentation: RenderPresentation): string {
	if (presentation.mode === "screen-reader") {
		return kind === "label" ? "edit: " : kind === "remove" ? "removed: " : "added: ";
	}
	const marker = kind === "label" ? "┄ " : kind === "remove" ? "▌- " : "▌+ ";
	return styleText(presentation, editLineColor(kind), marker);
}

function editStreamRows(
	lineText: string,
	kind: EditStreamKind,
	presentation: RenderPresentation,
	width: number,
	maxTailRows?: number,
): string[] {
	const prefix = editLinePrefix(kind, presentation);
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	let visibleText = lineText;
	if (maxTailRows !== undefined) {
		const totalWidth = visibleWidth(lineText);
		const rowBudget = contentWidth * maxTailRows;
		if (totalWidth > rowBudget) {
			const finalRowWidth = totalWidth % contentWidth || contentWidth;
			const rawBudget = Math.max(0, finalRowWidth + contentWidth * (maxTailRows - 1));
			visibleText = trailingTextByWidth(lineText, rawBudget);
		}
	}
	const body = styleText(presentation, editLineColor(kind), visibleText);
	return wrapWithHangingIndent(prefix, body, width);
}

export function renderEditPreviewLines(
	revealed: string,
	targetLines: readonly EditStreamLine[],
	presentation: RenderPresentation,
	width: number,
	expanded: boolean,
): { lines: string[]; truncated: boolean } {
	const w = normalizeWidth(width);
	if (targetLines.length === 0) return { lines: [], truncated: false };

	// revealed 是 targetText 的字符前缀，因此第 i 行必与 targetLines[i] 对齐（末行可为部分前缀）。
	const revealedLines = revealed.split("\n");
	// 末行还没揭示出任何字符而目标行非空时暂不渲染，避免出现裸标记行。
	const lastRevealed = revealedLines[revealedLines.length - 1] ?? "";
	const renderable = lastRevealed === "" && (targetLines[revealedLines.length - 1]?.text ?? "") !== ""
		? revealedLines.slice(0, -1)
		: revealedLines;
	if (renderable.length === 0) return { lines: [], truncated: false };
	const rowsAt = (index: number, maxTailRows?: number): string[] => editStreamRows(
		renderable[index] ?? "",
		targetLines[index]?.kind ?? "add",
		presentation,
		w,
		maxTailRows,
	);
	if (expanded) {
		const rows = renderable.flatMap((_line, index) => rowsAt(index));
		return { lines: clampLines(rows, w), truncated: false };
	}

	const rows: string[] = [];
	let truncated = false;
	for (let index = renderable.length - 1; index >= 0; index--) {
		if (rows.length >= EDIT_COLLAPSED_DISPLAY_LINES) {
			truncated = true;
			break;
		}
		const remaining = EDIT_COLLAPSED_DISPLAY_LINES - rows.length;
		const segments = rowsAt(index, remaining);
		if (segments.length > remaining) truncated = true;
		rows.unshift(...segments.slice(-remaining));
	}
	return { lines: clampLines(rows.slice(-EDIT_COLLAPSED_DISPLAY_LINES), w), truncated };
}

export class EditCallComponent implements Component {
	private path = "";
	private editCount = 0;
	private targetLines: EditStreamLine[] = [];
	private targetText = "";
	private revealed = "";
	private cwd: string | undefined;
	private expanded = false;
	private animationEnabled = false;
	private invalidateRow: (() => void) | undefined;
	private presentation: RenderPresentation = { mode: "color", diagnostics: false, theme: undefined };
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	update(
		args: unknown,
		presentation: RenderPresentation,
		context: RenderContextLike,
		settings: ReadmapRendererSettings,
	): void {
		const input = editStreamInput(args, presentation);
		const nextTarget = input.lines.map((line) => line.text).join("\n");
		if (!nextTarget.startsWith(this.revealed)) {
			this.revealed = nextTarget.slice(0, commonPrefixBoundary(this.revealed, nextTarget));
		}
		this.targetText = nextTarget;
		this.targetLines = input.lines;
		this.path = displayText(input.path, presentation);
		this.editCount = input.editCount;
		this.cwd = context.cwd;
		this.expanded = context.expanded ?? false;
		this.invalidateRow = context.invalidate;
		this.presentation = presentation;
		this.animationEnabled =
			settings.editAnimation !== false &&
			presentation.mode === "color" &&
			context.argsComplete !== true &&
			context.isPartial !== false;

		if (!this.animationEnabled) {
			this.revealed = this.targetText;
			unscheduleStreamAnimation(this);
		} else if (this.revealed !== this.targetText) {
			scheduleStreamAnimation(this);
		} else {
			unscheduleStreamAnimation(this);
		}
		this.invalidate();
	}

	advanceAnimation(): boolean {
		if (!this.animationEnabled || this.revealed === this.targetText) return false;
		const next = advanceStreamReveal(this.revealed, this.targetText);
		if (next === this.revealed) return false;
		this.revealed = next;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.invalidateRow?.();
		return this.animationEnabled && this.revealed !== this.targetText;
	}

	stop(): void {
		this.animationEnabled = false;
		unscheduleStreamAnimation(this);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const normalizedWidth = normalizeWidth(width);
		if (this.cachedLines && this.cachedWidth === normalizedWidth) return this.cachedLines;
		const preview = renderEditPreviewLines(
			this.revealed,
			this.targetLines,
			this.presentation,
			normalizedWidth,
			this.expanded,
		);
		const header = renderToolHeader(
			"edit",
			{ path: this.path },
			this.presentation,
			{ cwd: this.cwd, expanded: this.expanded },
			{
				phase: "running",
				meta: this.editCount > 0
					? [`${this.editCount} ${this.editCount === 1 ? "edit" : "edits"}`]
					: [],
				expandable: !this.expanded && preview.truncated,
			},
		);
		this.cachedWidth = normalizedWidth;
		this.cachedLines = clampLines([header, ...preview.lines], normalizedWidth);
		return this.cachedLines;
	}
}

export function reuseOrCreateEditCall(
	last: Component | undefined,
	args: unknown,
	presentation: RenderPresentation,
	context: RenderContextLike,
	settings: ReadmapRendererSettings,
): EditCallComponent {
	const component = last instanceof EditCallComponent ? last : new EditCallComponent();
	component.update(args, presentation, context, settings);
	return component;
}
