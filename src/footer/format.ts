import { basename, isAbsolute, relative, resolve, sep as pathSep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterColor, FooterTheme } from "./types.ts";

export const DOT = "·";

export function formatTokens(count: number): string {
	const value = Math.max(0, Math.round(count));
	if (value < 1000) return String(value);
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;
	return `${Math.round(value / 1000000)}M`;
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m${seconds % 60}s`;
	return `${seconds}s`;
}

export function formatCwd(cwd: string, home: string | undefined, mode: "full" | "abbrev" | "base" = "full"): string {
	if (mode === "base") return basename(cwd) || cwd;

	let display = cwd;
	if (home) {
		const resolvedCwd = resolve(cwd);
		const resolvedHome = resolve(home);
		const relativeToHome = relative(resolvedHome, resolvedCwd);
		const isInsideHome =
			relativeToHome === "" ||
			(relativeToHome !== ".." &&
				!relativeToHome.startsWith(`..${pathSep}`) &&
				!isAbsolute(relativeToHome));
		if (isInsideHome) {
			display = relativeToHome === "" ? "~" : `~${pathSep}${relativeToHome}`;
		}
	}

	if (mode === "abbrev" && display.length > 42) return `…${display.slice(-41)}`;
	return display;
}

export function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function joinParts(parts: Array<string | false | null | undefined>, separator: string): string {
	return parts.filter((part): part is string => Boolean(part)).join(separator);
}

export function softSeparator(theme: FooterTheme): string {
	return theme.fg("dim", ` ${DOT} `);
}

export function padBetween(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return left + " ".repeat(gap) + right;
}

export function segment(
	theme: FooterTheme,
	glyph: string,
	glyphColor: FooterColor,
	value: string,
	valueColor: FooterColor = "thinkingText",
): string {
	const icon = glyph ? `${theme.fg(glyphColor, glyph)} ` : "";
	return icon + theme.fg(valueColor, value);
}

export function contextTone(percent: number | null): "success" | "warning" | "error" {
	if (percent === null) return "success";
	if (percent > 90) return "error";
	if (percent > 70) return "warning";
	return "success";
}

export function cacheTone(rate: number): "success" | "warning" | "error" {
	if (rate >= 50) return "success";
	if (rate >= 25) return "warning";
	return "error";
}

export function thinkingStyle(level: string): { color: FooterColor; label: string } {
	switch (level) {
		case "max":
			return { color: "thinkingMax", label: "max" };
		case "xhigh":
			return { color: "thinkingXhigh", label: "xhigh" };
		case "high":
			return { color: "thinkingHigh", label: "high" };
		case "medium":
			return { color: "thinkingMedium", label: "med" };
		case "low":
			return { color: "thinkingLow", label: "low" };
		case "minimal":
			return { color: "thinkingMinimal", label: "min" };
		default:
			return { color: "thinkingOff", label: "off" };
	}
}

export function layoutSegments(segments: string[], separator: string, width: number): string[] {
	if (segments.length === 0) return [];

	const separatorWidth = visibleWidth(separator);
	const lines: string[][] = [[]];
	let lineWidth = 0;

	for (const currentSegment of segments) {
		const segmentWidth = visibleWidth(currentSegment);
		const currentLine = lines[lines.length - 1]!;
		const needed = segmentWidth + (currentLine.length > 0 ? separatorWidth : 0);

		if (currentLine.length > 0 && lineWidth + needed > width && lines.length < 2) {
			lines.push([currentSegment]);
			lineWidth = segmentWidth;
			continue;
		}

		currentLine.push(currentSegment);
		lineWidth += needed;
	}

	return lines
		.filter((parts) => parts.length > 0)
		.map((parts) => truncateToWidth(parts.join(separator), width, "…"));
}
