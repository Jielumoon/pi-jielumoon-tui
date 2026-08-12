/** Write 参数流的自适应逐字动画与语法高亮尾部预览；动画推进与调度在 stream-animation。 */

import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { asRecord } from "../guards.ts";
import type { RenderMode } from "../render-mode.ts";
import { renderToolHeader } from "./header.ts";
import {
	clampLine,
	clampLines,
	displayText,
	normalizeWidth,
	padStartVisible,
	styleText,
	type RenderPresentation,
	type ThemeLike,
} from "./presentation.ts";
import {
	advanceStreamReveal,
	commonPrefixBoundary,
	scheduleStreamAnimation,
	trailingTextByWidth,
	unscheduleStreamAnimation,
} from "./stream-animation.ts";
import type { ReadmapRendererSettings, RenderContextLike } from "./types.ts";

/** write 折叠态固定保留的终端显示行。 */
export const WRITE_COLLAPSED_DISPLAY_LINES = 8;
const WRITE_HIGHLIGHT_MAX_CHARS = 8_192;

export type WriteHighlightCache = {
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

export function writeInput(args: unknown): { path: string; content: string } {
	const record = asRecord(args);
	return {
		path: typeof record?.path === "string" ? record.path : "",
		content: typeof record?.content === "string" ? record.content : "",
	};
}

function writeLineLayout(
	rawLine: string,
	highlightedLine: string | undefined,
	lineNumber: number,
	lineNumberWidth: number,
	width: number,
	presentation: RenderPresentation,
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
		const totalWidth = visibleWidth(rawLine);
		const rowBudget = contentWidth * maxTailRows;
		if (totalWidth > rowBudget) {
			const finalRowWidth = totalWidth % contentWidth || contentWidth;
			const rawBudget = Math.max(0, finalRowWidth + contentWidth * (maxTailRows - 1));
			visibleRaw = trailingTextByWidth(rawLine, rawBudget);
		}
	}
	const body = highlightedLine ?? styleText(presentation, "toolOutput", visibleRaw);
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

export function renderWritePreviewLines(
	content: string,
	path: string,
	presentation: RenderPresentation,
	width: number,
	expanded: boolean,
	pending: boolean,
	cache?: WriteHighlightCache,
): { lines: string[]; cache: WriteHighlightCache } {
	const normalizedWidth = normalizeWidth(width);
	const nextCache = updateWriteHighlightCache(cache, content, path, presentation);
	if (content.length === 0) {
		// 流式尚未揭示任何内容时不放占位文案，避免"empty file"闪现。
		if (pending) return { lines: [], cache: nextCache };
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

export class WriteCallComponent implements Component {
	private targetContent = "";
	private revealedContent = "";
	private path = "";
	private cwd: string | undefined;
	private expanded = false;
	private animationEnabled = false;
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

		if (!this.animationEnabled) {
			this.revealedContent = this.targetContent;
			unscheduleStreamAnimation(this);
		} else if (this.revealedContent !== this.targetContent) {
			scheduleStreamAnimation(this);
		} else {
			unscheduleStreamAnimation(this);
		}
		this.invalidate();
	}

	advanceAnimation(): boolean {
		if (!this.animationEnabled || this.revealedContent === this.targetContent) return false;
		const next = advanceStreamReveal(this.revealedContent, this.targetContent);
		if (next === this.revealedContent) return false;
		this.revealedContent = next;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.invalidateRow?.();
		return this.animationEnabled && this.revealedContent !== this.targetContent;
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
		const preview = renderWritePreviewLines(
			this.revealedContent,
			this.path,
			this.presentation,
			normalizedWidth,
			this.expanded,
			this.animationEnabled,
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

export function reuseOrCreateWriteCall(
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
