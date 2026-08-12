import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokens } from "./footer/format.ts";
import type { FooterSettings } from "./footer/types.ts";
import { rgbForeground, type RGB } from "./gradient.ts";
import { isRecord } from "./guards.ts";
import { estimateTextTokens } from "./token-estimate.ts";

const WIDGET_KEY = "nano-context";
const IMAGE_TOKEN_ESTIMATE = 1200;

const COMPACT_BAR_MIN_WIDTH = 8;
const COMPACT_BAR_MAX_WIDTH = 20;

const USED_SEGMENTS: ReadonlyArray<{ key: "system" | "prompt" | "assistant" | "thinking" | "tools"; color: RGB }> = [
	{ key: "system", color: [130, 202, 122] }, // #82CA7A
	{ key: "prompt", color: [232, 155, 193] }, // #E89BC1
	{ key: "assistant", color: [139, 199, 194] }, // #8BC7C2
	{ key: "thinking", color: [115, 208, 210] }, // #73D0D2
	{ key: "tools", color: [216, 166, 87] }, // #D8A657
] as const;


type ContextSegmentKey = (typeof USED_SEGMENTS)[number]["key"];
type ContextSegments = Readonly<Record<ContextSegmentKey, number>>;
type WritableContextSegments = Record<ContextSegmentKey, number>;

export type ContextSnapshot = Readonly<{
	segments: ContextSegments;
	usedTokens: number;
	contextWindow: number;
	usageIsEstimated: boolean;
}>;

const emptyContextSegments = (): WritableContextSegments => ({
	system: 0,
	prompt: 0,
	assistant: 0,
	thinking: 0,
	tools: 0,
});

const fitStyledText = (text: string, width: number): string => truncateToWidth(text, width, "…");

const contentRecords = (content: unknown): readonly Record<string, unknown>[] =>
	Array.isArray(content) ? content.filter(isRecord) : [];

const textFromContent = (content: unknown): string => {
	if (typeof content === "string") return content;

	return contentRecords(content)
		.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
		.join("");
};

const imageCount = (content: unknown): number =>
	contentRecords(content).filter((part) => part.type === "image").length;

const estimateContentTokens = (content: unknown): number =>
	estimateTextTokens(textFromContent(content)) + imageCount(content) * IMAGE_TOKEN_ESTIMATE;

const estimateToolCallTokens = (part: Record<string, unknown>): number => {
	const name = typeof part.name === "string" ? part.name : "";
	const input = JSON.stringify(part.arguments ?? {});

	return estimateTextTokens(`${name}${input}`);
};

const addAssistantTokens = (segments: WritableContextSegments, content: unknown): void => {
	for (const part of contentRecords(content)) {
		if (part.type === "text" && typeof part.text === "string") {
			segments.assistant += estimateTextTokens(part.text);
		}

		if (part.type === "thinking" && typeof part.thinking === "string") {
			segments.thinking += estimateTextTokens(part.thinking);
		}

		if (part.type === "toolCall") {
			segments.assistant += estimateToolCallTokens(part);
		}
	}
};

type MessageSegmentCache = {
	role: unknown;
	content: unknown;
	segments: ContextSegments;
};

const messageSegmentCache = new WeakMap<object, MessageSegmentCache>();

const addSegments = (target: WritableContextSegments, source: ContextSegments): void => {
	target.system += source.system;
	target.prompt += source.prompt;
	target.assistant += source.assistant;
	target.thinking += source.thinking;
	target.tools += source.tools;
};

const segmentMessage = (message: Record<string, unknown>, forceRefresh: boolean): ContextSegments => {
	const cached = messageSegmentCache.get(message);
	if (!forceRefresh && cached !== undefined && cached.role === message.role && cached.content === message.content) {
		return cached.segments;
	}

	const segments = emptyContextSegments();
	if (message.role === "user") {
		segments.prompt = estimateContentTokens(message.content);
	} else if (message.role === "assistant") {
		addAssistantTokens(segments, message.content);
	} else if (message.role === "toolResult") {
		segments.tools = estimateContentTokens(message.content);
	}

	if (!forceRefresh) {
		messageSegmentCache.set(message, { role: message.role, content: message.content, segments });
	}
	return segments;
};

const segmentSessionMessages = (messages: readonly unknown[], systemPrompt: string): ContextSegments => {
	const segments = emptyContextSegments();
	segments.system = estimateTextTokens(systemPrompt);

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (!isRecord(message)) continue;
		addSegments(segments, segmentMessage(message, index === messages.length - 1));
	}

	return segments;
};

const segmentTotal = (segments: ContextSegments): number =>
	USED_SEGMENTS.reduce((total, segment) => total + segments[segment.key], 0);

const allocateProportionally = (values: readonly number[], columns: number): readonly number[] => {
	if (columns <= 0) return values.map(() => 0);

	const total = values.reduce((sum, value) => sum + value, 0);
	if (total <= 0) return values.map(() => 0);

	const rawColumns = values.map((value) => (value / total) * columns);
	const allocatedColumns = rawColumns.map(Math.floor);
	let remainingColumns = columns - allocatedColumns.reduce((sum, value) => sum + value, 0);

	const largestRemainders = rawColumns
		.map((value, index) => ({ index, remainder: value - Math.floor(value) }))
		.sort((left, right) => right.remainder - left.remainder);

	for (let index = 0; index < largestRemainders.length && remainingColumns > 0; index++, remainingColumns--) {
		const slot = largestRemainders[index]!;
		allocatedColumns[slot.index] = (allocatedColumns[slot.index] ?? 0) + 1;
	}

	return allocatedColumns;
};

const segmentsFromValues = (values: readonly number[]): ContextSegments => {
	const segments = emptyContextSegments();

	for (const [index, segment] of USED_SEGMENTS.entries()) {
		segments[segment.key] = values[index] ?? 0;
	}

	return segments;
};

const scaleSegmentsToUsage = (segments: ContextSegments, usedTokens: number): ContextSegments => {
	if (usedTokens <= 0 || segmentTotal(segments) <= 0) return segments;

	const values = USED_SEGMENTS.map((segment) => segments[segment.key]);

	return segmentsFromValues(allocateProportionally(values, Math.round(usedTokens)));
};

const sessionMessages = (ctx: ExtensionContext): readonly unknown[] => {
	const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
	return context.messages as readonly unknown[];
};

const makeContextSnapshot = (ctx: ExtensionContext, messages: readonly unknown[]): ContextSnapshot => {
	const rawSegments = segmentSessionMessages(messages, ctx.getSystemPrompt());
	const usage = ctx.getContextUsage();
	const measuredTokens = typeof usage?.tokens === "number" && usage.tokens > 0 ? usage.tokens : undefined;
	const estimatedTokens = segmentTotal(rawSegments);
	const usedTokens = measuredTokens ?? estimatedTokens;
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

	return {
		segments: scaleSegmentsToUsage(rawSegments, usedTokens),
		usedTokens,
		contextWindow,
		usageIsEstimated: measuredTokens === undefined,
	};
};

const allocateBarColumns = (values: readonly number[], width: number): readonly number[] => {
	const visibleUsedSegments = USED_SEGMENTS
		.map((_, index) => index)
		.filter((index) => (values[index] ?? 0) > 0);

	if (visibleUsedSegments.length === 0 || visibleUsedSegments.length >= width) {
		return allocateProportionally(values, width);
	}

	const minimumColumns = Array.from({ length: values.length }, () => 0);
	for (const index of visibleUsedSegments) minimumColumns[index] = 1;
	const remainingColumns = allocateProportionally(values, width - visibleUsedSegments.length);
	return minimumColumns.map((minimum, index) => minimum + (remainingColumns[index] ?? 0));
};

const renderCompactBar = (snapshot: ContextSnapshot, width: number, theme: Theme): string => {
	const freeTokens = Math.max(0, snapshot.contextWindow - snapshot.usedTokens);
	const values = [...USED_SEGMENTS.map((segment) => snapshot.segments[segment.key]), freeTokens];
	const columns = allocateBarColumns(values, width);
	const used = USED_SEGMENTS
		.map((segment, index) => rgbForeground(segment.color, "█".repeat(columns[index] ?? 0)))
		.join("");
	const free = theme.fg("dim", "░".repeat(columns[USED_SEGMENTS.length] ?? 0));
	return `${used}${free}`;
};

export const renderContextLine = (snapshot: ContextSnapshot, width: number, theme: Theme): string => {
	if (snapshot.contextWindow <= 0) return fitStyledText(theme.fg("dim", "ctx no model"), width);

	const rawPercent = (snapshot.usedTokens / snapshot.contextWindow) * 100;
	const prefix = snapshot.usageIsEstimated ? "~" : "";
	const percent = `${prefix}${rawPercent.toFixed(1)}%`;
	const total = `${prefix}${formatTokens(snapshot.usedTokens)}/${formatTokens(snapshot.contextWindow)}`;
	const tone = rawPercent >= 85 ? "error" : rawPercent >= 70 ? "warning" : "dim";
	const label = theme.fg("dim", "ctx");
	const percentText = theme.fg(tone, percent);
	if (width < 20) return fitStyledText(`${label} ${percentText}`, width);

	const preferredBarWidth = width >= 80 ? COMPACT_BAR_MAX_WIDTH : width >= 50 ? 14 : COMPACT_BAR_MIN_WIDTH;
	const detailedSuffix = ` ${percent} · ${total}`;
	const compactSuffix = ` ${percent}`;
	const suffix = preferredBarWidth + 4 + visibleWidth(detailedSuffix) <= width ? detailedSuffix : compactSuffix;
	const availableBarWidth = Math.max(
		COMPACT_BAR_MIN_WIDTH,
		Math.min(preferredBarWidth, width - visibleWidth("ctx ") - visibleWidth(suffix)),
	);
	const bar = renderCompactBar(snapshot, availableBarWidth, theme);
	const styledSuffix = suffix === detailedSuffix
		? ` ${percentText}${theme.fg("dim", ` · ${total}`)}`
		: ` ${percentText}`;
	return fitStyledText(`${label} ${bar}${styledSuffix}`, width);
};

const updateUi = (
	ctx: ExtensionContext,
	messages: readonly unknown[],
	settings: Pick<FooterSettings, "context">,
): void => {
	if (!ctx.hasUI) return;

	const snapshot = makeContextSnapshot(ctx, messages);
	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
		render: (width: number) => settings.context
			? [renderContextLine(snapshot, width, ctx.ui.theme ?? theme)]
			: [],
		invalidate: () => {},
	}), { placement: "belowEditor" });
};

export default function nanoContext(pi: ExtensionAPI, settings: Pick<FooterSettings, "context">): void {
	let activeMessages: readonly unknown[] | undefined;

	const refreshFromMessages = (ctx: ExtensionContext, messages: readonly unknown[]): void => {
		activeMessages = messages;
		updateUi(ctx, messages, settings);
	};

	const refreshFromSession = (ctx: ExtensionContext): void => {
		refreshFromMessages(ctx, sessionMessages(ctx));
	};

	const refreshFromActiveMessages = (ctx: ExtensionContext): void => {
		if (activeMessages) refreshFromMessages(ctx, activeMessages);
		else refreshFromSession(ctx);
	};

	pi.on("session_start", (_event, ctx) => refreshFromSession(ctx));

	pi.on("context", (event, ctx) => refreshFromMessages(ctx, event.messages));
	// Pi 的 agent_end.messages 只包含刚结束 run 的增量，不是完整模型上下文。
	pi.on("agent_end", (_event, ctx) => refreshFromActiveMessages(ctx));
	pi.on("model_select", (_event, ctx) => refreshFromActiveMessages(ctx));
	pi.on("thinking_level_select", (_event, ctx) => refreshFromActiveMessages(ctx));
	pi.on("session_compact", (_event, ctx) => refreshFromSession(ctx));
	pi.on("session_tree", (_event, ctx) => refreshFromSession(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
		activeMessages = undefined;
	});
}
