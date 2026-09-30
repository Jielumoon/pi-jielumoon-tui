/** canonical tool header：`◇ Read  path · meta` 一行式摘要，嵌入工具卡上边框。 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { asRecord } from "../guards.ts";
import { rgbForeground } from "../gradient.ts";
import { parsePatchEnvelopePaths } from "./apply-patch.ts";
import {
	displayText,
	EXPAND_KEY,
	styleText,
	themeBold,
	themeFg,
	type RenderPresentation,
	type ThemeLike,
} from "./presentation.ts";
import type { RenderContextLike, ToolPhase } from "./types.ts";

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

/** 父目录即 skill 名；`./SKILL.md`、`../SKILL.md` 这类相对段不算。 */
const SKILL_FILE = /(?:^|[\\/])(?!\.\.?[\\/])([^\\/]+)[\\/]SKILL\.md$/i;

/** `…/skills/<name>/SKILL.md` → `<name>`；read 加载 skill 时按 Skill 展示。 */
export function skillNameFromPath(path: unknown): string | undefined {
	return typeof path === "string" ? SKILL_FILE.exec(path)?.[1] : undefined;
}

/** Skill 主体：名字着 syntaxType，并链接到 SKILL.md。 */
export function skillSubject(
	name: string,
	location: string,
	presentation: RenderPresentation,
	cwd: string | undefined,
): ToolSubject {
	const styled = styleText(presentation, "syntaxType", displayText(name, presentation));
	return {
		label: "Skill",
		labelColor: "mdHeading",
		target: presentation.mode === "color" ? linkPath(styled, location, cwd) : styled,
		meta: [],
	};
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

function toolLabel(theme: ThemeLike | undefined, name: string, color = "toolTitle"): string {
	const label = name.length > 0 ? `${name[0]!.toUpperCase()}${name.slice(1)}` : "Tool";
	// Codemode 固定为 Sakura lavender，不借用可能是蓝色的主题 accent。
	if (name === "codemode" && theme) return rgbForeground([199, 184, 245], label, true);
	return themeFg(theme, color, themeBold(theme, label));
}

export type LineRange = { start: number; end: number };

const LINE_RANGE_SEPARATOR = " ~ ";
const LINE_RANGE_PATTERN = /^\d+ ~ \d+$/;
/** mcpScript 的失败计数徽章。 */
const FAILED_META_PATTERN = /^\d+ failed$/;

export function phaseMarker(presentation: RenderPresentation, phase: ToolPhase): string {
	if (presentation.mode !== "color") return "";
	const marker = phase === "running" ? "◇" : phase === "error" ? "×" : phase === "noop" ? "·" : "✓";
	const color = phase === "running" ? "accent" : phase === "error" ? "error" : phase === "noop" ? "dim" : "success";
	return styleText(presentation, color, marker);
}

/** Provider 网关可能把 offset/limit 序列化为数字字符串。 */
export function normalizeLineNumber(value: unknown): number | undefined {
	const parsed = typeof value === "number"
		? value
		: typeof value === "string" && /^\d+$/.test(value.trim())
			? Number(value)
			: Number.NaN;
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function parseLineRange(args: Record<string, unknown> | undefined): LineRange | undefined {
	const offset = normalizeLineNumber(args?.offset);
	const limit = normalizeLineNumber(args?.limit);
	if (offset === undefined || limit === undefined) return undefined;
	const end = offset + limit - 1;
	return Number.isSafeInteger(end) ? { start: offset, end } : undefined;
}

export function formatLineRange(range: LineRange | undefined, inPath = false): string {
	if (!range) return "";
	const formatted = `${range.start}${LINE_RANGE_SEPARATOR}${range.end}`;
	return inPath ? `:${formatted}` : formatted;
}

export function isLineRangeFormat(value: string): boolean {
	return LINE_RANGE_PATTERN.test(value);
}

/**
 * 标题主体：label 缺省为首字母大写的工具名，target 已着色。
 * labelColor 为主题色名，按工具类别区分标签颜色（缺省 toolTitle，即本地文件/代码类）。
 */
export type ToolSubject = { label?: string; labelColor?: string; target: string; meta: string[] };

export function toolSubject(
	name: string,
	args: unknown,
	presentation: RenderPresentation,
	context: RenderContextLike,
	phase: ToolPhase,
	pathWidth = 48,
): ToolSubject {
	const record = asRecord(args) ?? {};
	// pi-fff 用空字符串表示工作目录，与缺省 path 同样显示为 `.`。
	const path = typeof record.path === "string" && record.path.length > 0
		? displayText(record.path, presentation)
		: name === "ls" || name === "grep" || name === "find" ? "." : "";
	const linkedPath = (): string => {
		if (!path) return styleText(presentation, "toolOutput", "…");
		const shown = shortenPath(path, pathWidth);
		const styled = styleText(presentation, "syntaxType", shown);
		return presentation.mode === "color" ? linkPath(styled, path, context.cwd) : styled;
	};

	if (name === "read") {
		const skill = skillNameFromPath(record.path);
		if (skill && path) return skillSubject(skill, path, presentation, context.cwd);
		const meta: string[] = [];
		if (typeof record.symbol === "string") meta.push(`symbol: ${displayText(record.symbol, presentation)}`);
		const suffix = phase === "running" ? formatLineRange(parseLineRange(record), true) : "";
		const target = linkedPath();
		return {
			target: path && suffix ? `${target}${styleText(presentation, "syntaxNumber", suffix)}` : target,
			meta,
		};
	}
	if (name === "edit" || name === "write" || name === "create" || name === "overwrite") {
		return { target: linkedPath(), meta: [] };
	}
	if (name === "apply_patch") {
		const input = typeof record.input === "string" ? record.input : "";
		const paths = parsePatchEnvelopePaths(input);
		if (paths.length === 0) return { target: styleText(presentation, "toolOutput", "…"), meta: [] };
		const primary = displayText(paths[0]!, presentation);
		const styled = styleText(presentation, "syntaxType", shortenPath(primary, pathWidth));
		return {
			target: presentation.mode === "color" ? linkPath(styled, primary, context.cwd) : styled,
			meta: paths.length > 1 ? [`${paths.length} files`] : [],
		};
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
	if (name === "grep" || name === "find") {
		const rawPattern = typeof record.pattern === "string" ? displayText(record.pattern, presentation) : "";
		const fitted = truncateToWidth(rawPattern, 40, "…");
		const patternText = rawPattern.length === 0
			? styleText(presentation, "toolOutput", "…")
			: styleText(presentation, "accent", name === "grep" ? `/${fitted}/` : fitted);
		const meta: string[] = [];
		if (name === "grep") {
			if (typeof record.glob === "string") meta.push(`glob: ${displayText(record.glob, presentation)}`);
			if (record.ignoreCase === true) meta.push("-i");
			if (record.literal === true) meta.push("literal");
			if (typeof record.context === "number" && record.context > 0) meta.push(`±${record.context}`);
		}
		if (typeof record.limit === "number") meta.push(`limit: ${record.limit}`);
		return {
			target: `${patternText}${styleText(presentation, "dim", " in ")}${linkedPath()}`,
			meta,
		};
	}
	return { target: "", meta: [] };
}

function styleToolMeta(presentation: RenderPresentation, value: string): string {
	if (isLineRangeFormat(value)) return styleText(presentation, "syntaxNumber", value);
	if (FAILED_META_PATTERN.test(value)) return styleText(presentation, "error", value);
	const stats = /^(\+\d+)\s+(−\d+)$/u.exec(value);
	if (!stats) return styleText(presentation, "dim", value);
	return `${styleText(presentation, "toolDiffAdded", stats[1]!)} ${styleText(presentation, "toolDiffRemoved", stats[2]!)}`;
}

export function renderToolHeader(
	name: string,
	args: unknown,
	presentation: RenderPresentation,
	context: RenderContextLike,
	options: { phase: ToolPhase; meta?: readonly string[]; expandable?: boolean; subject?: ToolSubject },
): string {
	const subject = options.subject
		?? toolSubject(name, args, presentation, context, options.phase);
	// 徽章可能来自 details（MCP summary、提问答案等外部文本），着色前统一净化控制序列。
	const meta = [...new Set([...subject.meta, ...(options.meta ?? [])]
		.map((item) => displayText(item, presentation))
		.filter((item) => item.length > 0))];
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

	const title = subject.label ?? name;
	const label = `${toolLabel(presentation.theme, title, subject.labelColor)}${subject.target ? `  ${subject.target}` : ""}`;
	const marker = phaseMarker(presentation, options.phase);
	const head = marker ? `${marker} ${label}` : label;
	if (meta.length === 0) return head;
	const separator = styleText(presentation, "dim", " · ");
	return `${head}${separator}${meta.map((item) => styleToolMeta(presentation, item)).join(separator)}`;
}
