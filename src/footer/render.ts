import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { blackholeMetricTone, formatBlackholeCooldowns, formatBlackholeMetric } from "./blackhole.ts";
import {
	formatUsageReset,
	type SubscriptionUsageState,
	type UsageWindow,
} from "./subscription-usage.ts";
import {
	cacheTone,
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
	FooterColor,
	FooterRenderData,
	FooterSettings,
	FooterSnapshot,
	FooterTheme,
	IconSet,
} from "./types.ts";

function renderPathLine(
	theme: FooterTheme,
	snapshot: FooterSnapshot,
	settings: FooterSettings,
	renderData: FooterRenderData,
	icons: IconSet,
	width: number,
): string {
	const separator = softSeparator(theme);
	const thinking = settings.thinking && snapshot.model?.reasoning ? thinkingStyle(snapshot.thinkingLevel) : null;
	const model = settings.model && snapshot.model
		? theme.bold(theme.fg("accent", `${icons.model} ${snapshot.model.id}`))
		: null;
	const provider = settings.provider && snapshot.model ? theme.fg("muted", snapshot.model.provider) : null;
	const thinkingLabel = thinking ? theme.fg(thinking.color, `${icons.thinking} ${thinking.label}`) : null;
	const rightCandidates = [
		joinParts([provider, model, thinkingLabel], separator),
		joinParts([model, thinkingLabel], separator),
		model ?? thinkingLabel ?? "",
	].filter(Boolean);
	const rightBudget = settings.path ? Math.max(10, Math.floor(width * (width >= 80 ? 0.48 : 0.42))) : width;
	const right = rightCandidates.find((candidate) => visibleWidth(candidate) <= rightBudget)
		?? truncateToWidth(rightCandidates.at(-1) ?? "", rightBudget, theme.fg("dim", "…"));
	const rightWidth = visibleWidth(right);
	const leftBudget = rightWidth > 0 ? Math.max(0, width - rightWidth - 2) : width;

	let left = "";
	if (settings.path && leftBudget > 0) {
		const pathMode = leftBudget < 32 ? "base" : leftBudget < 70 ? "abbrev" : "full";
		const path = formatCwd(snapshot.cwd, process.env.HOME || process.env.USERPROFILE, pathMode);
		const pathPart = segment(theme, icons.path, "mdLink", path, "text");
		const branchPart = renderData.branch ? segment(theme, icons.branch, "mdQuote", renderData.branch, "thinkingText") : null;
		const sessionPart = snapshot.sessionName
			? segment(theme, icons.session, "customMessageLabel", snapshot.sessionName, "thinkingText")
			: null;
		const candidates = [
			joinParts([pathPart, branchPart, sessionPart], separator),
			joinParts([pathPart, branchPart], separator),
			pathPart,
		];
		left = candidates.find((candidate) => visibleWidth(candidate) <= leftBudget)
			?? truncateToWidth(pathPart, leftBudget, theme.fg("dim", "…"));
	}

	if (!left) return truncateToWidth(right, width, theme.fg("dim", "…"));
	if (!right) return truncateToWidth(left, width, theme.fg("dim", "…"));
	return padBetween(left, right, width);
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

function modelIdentity(snapshot: FooterSnapshot): string | undefined {
	return snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : undefined;
}

function quotaTone(remaining: number): FooterColor {
	if (remaining <= 20) return "error";
	if (remaining <= 50) return "warning";
	return "success";
}

function renderQuotaWindow(
	theme: FooterTheme,
	window: UsageWindow,
	now: number,
	showReset: boolean,
): string | null {
	if (window.unit === "usd" && typeof window.remaining === "number") {
		return theme.fg("dim", "余额 ") + theme.fg("success", `$${Math.max(0, window.remaining).toFixed(2)}`);
	}
	if (typeof window.usedPercent !== "number") return null;

	const remaining = Number.isFinite(window.usedPercent) ? Math.max(0, Math.min(100, 100 - window.usedPercent)) : 0;
	const reset = showReset ? formatUsageReset(window.resetAt, now) ?? window.resetDescription : undefined;
	return (
		theme.fg("dim", `${window.label} `) +
		theme.fg(quotaTone(remaining), `${remaining.toFixed(0)}%`) +
		(reset ? theme.fg("dim", ` ↻ ${reset}`) : "")
	);
}


function renderSubscriptionUsage(
	theme: FooterTheme,
	snapshot: FooterSnapshot,
	state: SubscriptionUsageState | undefined,
	includeProviderLabel: boolean,
	width: number,
): string | null {
	if (!state || state.modelIdentity !== modelIdentity(snapshot)) return null;
	if (state.kind === "notice") {
		const prefix = includeProviderLabel ? `${state.displayName} ` : "";
		switch (state.notice) {
			case "unavailable":
				return theme.fg("dim", `${prefix}额度不可用`);
			case "retrying":
				return theme.fg("warning", `${prefix}额度稍后重试`);
			case "timeout":
				return theme.fg("warning", `${prefix}额度请求超时`);
			case "request-failed":
				return theme.fg("warning", `${prefix}额度暂不可用`);
		}
	}

	const separator = softSeparator(theme);
	const providerLabel = includeProviderLabel ? theme.fg("muted", state.usage.displayName) : null;
	const renderWindows = (showReset: boolean, count: number): string | null => {
		const windows = state.usage.windows
			.map((window) => renderQuotaWindow(theme, window, snapshot.nowMs, showReset))
			.filter((window): window is string => window !== null)
			.slice(0, count);
		return windows.length > 0 ? joinParts([providerLabel, ...windows], separator) : null;
	};
	const candidates = [
		renderWindows(true, 2),
		renderWindows(false, 2),
		renderWindows(true, 1),
		renderWindows(false, 1),
	].filter((value): value is string => value !== null);
	const display = candidates.find((value) => visibleWidth(value) <= width) ?? candidates.at(-1);
	return display ? truncateToWidth(display, width, theme.fg("dim", "…")) : null;
}


function renderStatsLines(
	theme: FooterTheme,
	snapshot: FooterSnapshot,
	settings: FooterSettings,
	renderData: FooterRenderData,
	icons: IconSet,
	width: number,
): string[] {
	const separator = softSeparator(theme);
	const segments: string[] = [];

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

	const elapsed = settings.elapsed ? snapshot.nowMs - snapshot.sessionStartMs : 0;
	const right = elapsed >= 5000 ? segment(theme, icons.time, "dim", formatDuration(elapsed), "dim") : "";
	const rightWidth = visibleWidth(right);
	const leftBudget = rightWidth > 0 ? Math.max(16, width - rightWidth - 2) : width;
	const quota = settings.extensions
		? renderSubscriptionUsage(theme, snapshot, renderData.subscriptionUsage, !settings.provider, leftBudget)
		: null;
	if (quota) segments.push(quota);

	const leftLines = layoutSegments(segments, separator, leftBudget);
	if (leftLines.length === 0) return rightWidth > 0 ? [padBetween("", right, width)] : [];

	const lines: string[] = [];
	const firstLeft = leftLines[0]!;
	if (rightWidth === 0) lines.push(firstLeft);
	else if (visibleWidth(firstLeft) + 2 + rightWidth <= width) lines.push(padBetween(firstLeft, right, width));
	else lines.push(`${truncateToWidth(firstLeft, Math.max(0, width - rightWidth - 1), theme.fg("dim", "…"))} ${right}`);
	lines.push(...leftLines.slice(1));
	return lines;
}

const PLANNING_STATUS_KEY = "planning-with-files";

function isQuietExtensionStatus(key: string, text: string): boolean {
	const state = "(?:ready|complete|completed|idle|ok)";
	if (new RegExp(`^${state}$`, "i").test(text)) return true;
	if (key === PLANNING_STATUS_KEY && /^\d+\/\d+\s+phases?\s+completed?$/i.test(text)) return true;
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escapedKey}\\s+${state}$`, "i").test(text);
}

function renderExtensionStatusLine(
	theme: FooterTheme,
	statuses: ReadonlyMap<string, string>,
	width: number,
	showPlanning: boolean,
): string | null {
	const entries = Array.from(statuses.entries())
		.map(([key, text]) => [key, text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim()] as const)
		.filter(([key, text]) => Boolean(text) && !isQuietExtensionStatus(key, text));
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

	if (settings.path || settings.model || settings.provider || settings.thinking) {
		const pathLine = renderPathLine(theme, snapshot, settings, renderData, icons, width);
		if (pathLine) lines.push(pathLine);
	}
	lines.push(...renderStatsLines(theme, snapshot, settings, renderData, icons, width));
	if (settings.blackhole && snapshot.blackhole) {
		lines.push(renderBlackholeLine(theme, snapshot.blackhole, icons, width));
	}
	if (settings.extensions) {
		const statusLine = renderExtensionStatusLine(theme, renderData.extensionStatuses, width, settings.planning);
		if (statusLine) lines.push(statusLine);
	}

	return lines;
}
