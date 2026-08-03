import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { blackholeMetricTone, formatBlackholeCooldowns, formatBlackholeMetric } from "./blackhole.ts";
import {
	cacheTone,
	contextTone,
	formatCwd,
	formatDuration,
	formatTokens,
	joinParts,
	layoutSegments,
	padBetween,
	segment,
	softSeparator,
	thinkingStyle,
} from "./format.ts";
import type {
	FooterRenderData,
	FooterSettings,
	FooterSnapshot,
	FooterTheme,
	IconSet,
} from "./types.ts";

function renderPathLine(
	theme: FooterTheme,
	snapshot: FooterSnapshot,
	renderData: FooterRenderData,
	icons: IconSet,
	width: number,
): string {
	const pathMode = width < 60 ? "base" : width < 100 ? "abbrev" : "full";
	const path = formatCwd(snapshot.cwd, process.env.HOME || process.env.USERPROFILE, pathMode);

	const line = joinParts(
		[
			segment(theme, icons.path, "mdLink", path, "text"),
			renderData.branch ? segment(theme, icons.branch, "mdQuote", renderData.branch, "thinkingText") : null,
			snapshot.sessionName
				? segment(theme, icons.session, "customMessageLabel", snapshot.sessionName, "thinkingText")
				: null,
		],
		softSeparator(theme),
	);

	return truncateToWidth(line, width, theme.fg("dim", "…"));
}

function renderBlackholeLine(
	theme: FooterTheme,
	status: NonNullable<FooterSnapshot["blackhole"]>,
	icons: IconSet,
	width: number,
): string {
	const mode = status.compaction === "auto" ? "auto" : status.compaction;
	const engine = status.compactionEngine === "pi-default" ? "/pi" : "";
	const memory = status.memory ? "" : " M-off";
	const metric = (label: string, value: number, threshold: number): string =>
		theme.fg(blackholeMetricTone(status, value, threshold), `${label}·${formatBlackholeMetric(value, threshold)}`);
	const parts = [
		segment(theme, icons.blackhole, "syntaxOperator", `BH ${mode}${engine}${memory}`, "muted"),
		metric("O", status.observerTokens, status.observerThreshold),
		metric("R", status.reflectorTokens, status.reflectorThreshold),
		metric("P", status.poolTokens, status.poolThreshold),
	];
	if (width >= 120) parts.push(metric("C", status.compactionTokens, status.compactionThreshold));

	const left = parts.join(softSeparator(theme));
	const cooldownText = formatBlackholeCooldowns(status.cooldowns);
	if (!cooldownText) return truncateToWidth(left, width, theme.fg("dim", "…"));

	const right = segment(theme, icons.time, "warning", cooldownText, "warning");
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, theme.fg("dim", "…"));
	if (visibleWidth(left) + rightWidth + 1 <= width) return padBetween(left, right, width);

	const leftWidth = Math.max(0, width - rightWidth - 1);
	return `${truncateToWidth(left, leftWidth, theme.fg("dim", "…"))} ${right}`;
}

function renderStatsLines(
	theme: FooterTheme,
	snapshot: FooterSnapshot,
	settings: FooterSettings,
	icons: IconSet,
	width: number,
): string[] {
	const separator = softSeparator(theme);
	const segments: string[] = [];

	if (settings.context) {
		const { percent, contextWindow } = snapshot.context;
		const tone = contextTone(percent);
		const percentLabel = percent !== null ? `${percent.toFixed(1)}%` : "?";
		const windowLabel = theme.fg("dim", `/${formatTokens(contextWindow)}`);
		segments.push(segment(theme, icons.context, tone, "") + theme.fg(tone, percentLabel) + windowLabel);
	}

	if (settings.traffic && (snapshot.usage.input || snapshot.usage.output)) {
		const traffic: string[] = [];
		if (snapshot.usage.input) {
			traffic.push(segment(theme, icons.input, "mdLink", formatTokens(snapshot.usage.input), "mdLink"));
		}
		if (snapshot.usage.output) {
			traffic.push(segment(theme, icons.output, "success", formatTokens(snapshot.usage.output), "success"));
		}
		segments.push(traffic.join(" "));
	}

	if (settings.cache && (snapshot.usage.cacheRead || snapshot.usage.cacheWrite)) {
		const cache: string[] = [];
		if (snapshot.usage.cacheRead) {
			cache.push(segment(theme, icons.cacheRead, "syntaxOperator", formatTokens(snapshot.usage.cacheRead), "syntaxOperator"));
		}
		if (snapshot.usage.cacheWrite) {
			cache.push(segment(theme, icons.cacheWrite, "syntaxType", formatTokens(snapshot.usage.cacheWrite), "syntaxType"));
		}
		if (snapshot.usage.cacheHitRate !== undefined) {
			const hit = snapshot.usage.cacheHitRate;
			const hitTone = cacheTone(hit);
			cache.push(segment(theme, icons.cacheHit, hitTone, `${hit.toFixed(0)}%`, hitTone));
		}
		segments.push(cache.join(" "));
	}

	if (settings.cost && snapshot.usage.cost > 0) {
		const amount = snapshot.model?.usingOAuth ? `${snapshot.usage.cost.toFixed(3)} sub` : snapshot.usage.cost.toFixed(3);
		segments.push(segment(theme, icons.cost, "warning", amount, "warning"));
	}

	if (settings.elapsed) {
		const elapsed = snapshot.nowMs - snapshot.sessionStartMs;
		if (elapsed >= 5000) segments.push(segment(theme, icons.time, "dim", formatDuration(elapsed), "dim"));
	}

	const thinking = settings.thinking && snapshot.model?.reasoning ? thinkingStyle(snapshot.thinkingLevel) : null;
	const right = joinParts(
		[
			settings.provider && snapshot.model ? theme.fg("muted", snapshot.model.provider) : null,
			settings.model
				? theme.bold(theme.fg("accent", `${icons.model} ${snapshot.model?.id ?? "no-model"}`))
				: null,
			thinking ? theme.fg(thinking.color, `${icons.thinking} ${thinking.label}`) : null,
		],
		separator,
	);

	const rightWidth = visibleWidth(right);
	const leftBudget = rightWidth > 0 ? Math.max(20, width - rightWidth - 2) : width;
	const leftLines = layoutSegments(segments, separator, leftBudget);
	if (leftLines.length === 0) return rightWidth > 0 ? [truncateToWidth(right, width, theme.fg("dim", "…"))] : [];

	const firstLeft = leftLines[0]!;
	let first: string;
	if (rightWidth === 0) {
		first = firstLeft;
	} else if (visibleWidth(firstLeft) + 2 + rightWidth <= width) {
		first = padBetween(firstLeft, right, width);
	} else {
		const available = Math.max(0, width - visibleWidth(firstLeft) - 1);
		first = firstLeft + " " + truncateToWidth(right, available, theme.fg("dim", "…"));
	}

	return [first, ...leftLines.slice(1)];
}

const PLANNING_STATUS_KEY = "planning-with-files";

function renderExtensionStatusLine(
	theme: FooterTheme,
	statuses: ReadonlyMap<string, string>,
	width: number,
	showPlanning: boolean,
): string | null {
	const entries = Array.from(statuses.entries())
		.map(([key, text]) => [key, text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim()] as const)
		.filter(([, text]) => Boolean(text));
	if (entries.length === 0) return null;

	const separator = softSeparator(theme);
	const left = entries
		.filter(([key]) => key !== PLANNING_STATUS_KEY)
		.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
		.map(([, text]) => text)
		.join(separator);
	const planning = showPlanning ? entries.find(([key]) => key === PLANNING_STATUS_KEY)?.[1] : undefined;

	if (!planning) return left ? truncateToWidth(left, width, theme.fg("dim", "…")) : null;

	const right = truncateToWidth(planning, width, theme.fg("dim", "…"));
	const rightWidth = visibleWidth(right);
	if (!left) return `${" ".repeat(Math.max(0, width - rightWidth))}${right}`;

	const leftWidth = width - rightWidth - 1;
	if (leftWidth <= 0) return right;

	return padBetween(truncateToWidth(left, leftWidth, theme.fg("dim", "…")), right, width);
}

export function renderFooter(
	snapshot: FooterSnapshot,
	settings: FooterSettings,
	renderData: FooterRenderData,
	width: number,
	theme: FooterTheme,
	icons: IconSet,
): string[] {
	const lines: string[] = [];

	if (settings.path) lines.push(renderPathLine(theme, snapshot, renderData, icons, width));
	lines.push(...renderStatsLines(theme, snapshot, settings, icons, width));
	if (settings.blackhole && snapshot.blackhole) {
		lines.push(renderBlackholeLine(theme, snapshot.blackhole, icons, width));
	}
	if (settings.extensions) {
		const statusLine = renderExtensionStatusLine(theme, renderData.extensionStatuses, width, settings.planning);
		if (statusLine) lines.push(statusLine);
	}

	return lines;
}
