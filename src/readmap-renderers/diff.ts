/** edit / overwrite 的 diff 正文：unified / split / compact / summary 四种宽度模式。 */

import type { Component } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { asRecord } from "../guards.ts";
import {
	asThemeLike,
	clampLine,
	clampLines,
	collapsedHint,
	displayText,
	normalizeWidth,
	padEndVisible,
	padStartVisible,
	styleText,
	wrapWithHangingIndent,
	type RenderPresentation,
	type ThemeLike,
} from "./presentation.ts";

/** edit/write diff 折叠态最多展示的变更行。 */
const DIFF_COLLAPSED_PREVIEW_LINES = 6;
const SPLIT_DIFF_MIN_WIDTH = 120;
const SUMMARY_DIFF_MAX_WIDTH = 23;

export type DiffEntry =
	| { kind: "context"; oldLine: number; newLine: number; text: string }
	| { kind: "add"; newLine: number; text: string }
	| { kind: "remove"; oldLine: number; text: string }
	| { kind: "meta"; text: string };

export type DiffSpan = { kind: "equal" | "add" | "remove"; text: string };

export type InlineDiff = {
	removeLineIndex: number;
	addLineIndex: number;
	removeSpans: DiffSpan[];
	addSpans: DiffSpan[];
};

export type DiffBlockRange = {
	kind: "add" | "remove";
	startLine: number;
	endLine: number;
};

export type DiffData = {
	version?: number;
	entries: DiffEntry[];
	stats: { added: number; removed: number; context?: number };
	language?: string;
	blockRanges?: DiffBlockRange[];
	inlineDiffs?: InlineDiff[];
};

export function isDiffData(value: unknown): value is DiffData {
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
	// inlineDiffs / blockRanges 按索引预建 Map：大 diff 下逐条 find 是 O(n·m)。
	// 与原 find 语义一致：仅接受结构合法的项，重复索引首个生效。
	const inlineByRemoveIndex = new Map<number, InlineDiff>();
	const inlineByAddIndex = new Map<number, InlineDiff>();
	if (Array.isArray(diffData.inlineDiffs)) {
		for (const candidate of diffData.inlineDiffs) {
			const record = asRecord(candidate);
			if (
				record === undefined ||
				typeof record.removeLineIndex !== "number" ||
				typeof record.addLineIndex !== "number"
			) continue;
			const pair = candidate as InlineDiff;
			if (!inlineByRemoveIndex.has(pair.removeLineIndex)) inlineByRemoveIndex.set(pair.removeLineIndex, pair);
			if (!inlineByAddIndex.has(pair.addLineIndex)) inlineByAddIndex.set(pair.addLineIndex, pair);
		}
	}
	const rangeByKindStart = new Map<string, DiffBlockRange>();
	if (Array.isArray(diffData.blockRanges)) {
		for (const candidate of diffData.blockRanges) {
			const record = asRecord(candidate);
			if (
				record === undefined ||
				(record.kind !== "add" && record.kind !== "remove") ||
				typeof record.startLine !== "number" ||
				typeof record.endLine !== "number"
			) continue;
			const key = `${record.kind}:${record.startLine}`;
			if (!rangeByKindStart.has(key)) rangeByKindStart.set(key, candidate as DiffBlockRange);
		}
	}
	const inlineText = (index: number, entry: DiffEntry): string => {
		const pair = entry.kind === "remove"
			? inlineByRemoveIndex.get(index)
			: entry.kind === "add"
				? inlineByAddIndex.get(index)
				: undefined;
		const spans = pair
			? entry.kind === "remove"
				? pair.removeSpans
				: pair.addSpans
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
		const line = entry.kind === "add" ? entry.newLine : entry.kind === "remove" ? entry.oldLine : undefined;
		if (line === undefined) return undefined;
		const range = rangeByKindStart.get(`${entry.kind}:${line}`);
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

export function reuseOrCreateDiff(
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
