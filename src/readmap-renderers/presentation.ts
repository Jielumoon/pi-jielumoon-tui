/** 输出模式、主题着色、宽度排版与外部文本净化——所有 renderer 共享的底层。 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { resolveRenderMode, type RenderMode } from "../render-mode.ts";

export const EXPAND_KEY = "Ctrl+O";
const EXPAND_HINT = ` · ${EXPAND_KEY}`;

export type RenderPresentation = {
	mode: RenderMode;
	diagnostics: boolean;
	theme: ThemeLike | undefined;
};

export type ThemeLike = {
	// color 用 string 宽化，兼容 Pi ThemeColor 与 mock theme
	fg?: (color: string, text: string) => string;
	bold?: (text: string) => string;
};

export function asThemeLike(theme: unknown): ThemeLike | undefined {
	return theme as ThemeLike | undefined;
}

// ─── theme / width ───────────────────────────────────────────────

export function themeFg(theme: ThemeLike | undefined, color: string, text: string): string {
	if (!theme?.fg) return text;
	try {
		return theme.fg(color, text);
	} catch {
		return text;
	}
}

export function themeBold(theme: ThemeLike | undefined, text: string): string {
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

export function sanitizeTerminalText(value: string, diagnostics = false): string {
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


export function resolvePresentation(theme: unknown): RenderPresentation {
	const requested = resolveRenderMode();
	return {
		mode: requested,
		diagnostics: process.env.PI_READMAP_DIAGNOSTICS === "1",
		theme: requested === "color" ? asThemeLike(theme) : undefined,
	};
}

export function displayText(value: string, presentation: RenderPresentation): string {
	return sanitizeTerminalText(value, presentation.diagnostics);
}

export function styleText(presentation: RenderPresentation, color: string, text: string): string {
	return themeFg(presentation.theme, color, text);
}

export function padStartVisible(value: string, width: number): string {
	return " ".repeat(Math.max(0, width - visibleWidth(value))) + value;
}

export function padEndVisible(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

export function collapsedHint(
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

export function wrapWithHangingIndent(prefix: string, content: string, width: number): string[] {
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
