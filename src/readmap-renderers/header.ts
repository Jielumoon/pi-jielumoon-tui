/** canonical tool header：`◇ Read  path · meta` 一行式摘要，嵌入工具卡上边框。 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities, hyperlink, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { asRecord } from "../guards.ts";
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

function toolLabel(theme: ThemeLike | undefined, name: string): string {
	const label = name.length > 0 ? `${name[0]!.toUpperCase()}${name.slice(1)}` : "Tool";
	return themeFg(theme, "toolTitle", themeBold(theme, label));
}

export function phaseMarker(presentation: RenderPresentation, phase: ToolPhase): string {
	if (presentation.mode !== "color") return "";
	const marker = phase === "running" ? "◇" : phase === "error" ? "×" : phase === "noop" ? "·" : "✓";
	const color = phase === "running" ? "accent" : phase === "error" ? "error" : phase === "noop" ? "dim" : "success";
	return styleText(presentation, color, marker);
}

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

export function renderToolHeader(
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
