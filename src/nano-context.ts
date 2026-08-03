import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "nano-context";
const CHARACTERS_PER_TOKEN = 4;
const IMAGE_TOKEN_ESTIMATE = 1200;
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const USED_SEGMENT_TEXT = "#15181D";
const FREE_SEGMENT_FILL = "#242731";
const FREE_SEGMENT_TEXT = "#C7D46A";

const USED_SEGMENTS = [
	{ key: "system", color: "#82CA7A", labels: ["system", "sys", "s"] },
	{ key: "prompt", color: "#E89BC1", labels: ["prompt", "pr", "p"] },
	{ key: "assistant", color: "#8BC7C2", labels: ["assistant", "ast", "a"] },
	{ key: "thinking", color: "#73D0D2", labels: ["think", "th", "t"] },
	{ key: "tools", color: "#D8A657", labels: ["tools", "tl", "x"] },
] as const;

const FREE_SEGMENT_LABELS = ["free", "fr", "f"] as const;

type ContextSegmentKey = (typeof USED_SEGMENTS)[number]["key"];
type ContextSegments = Readonly<Record<ContextSegmentKey, number>>;
type WritableContextSegments = Record<ContextSegmentKey, number>;

type ContextSnapshot = Readonly<{
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

const stripAnsi = (text: string): string => text.replace(ANSI_PATTERN, "");

const plainWidth = (text: string): number => Array.from(stripAnsi(text)).length;

const truncatePlainText = (text: string, width: number): string => {
	if (width <= 0) return "";

	const characters = Array.from(text);
	if (characters.length <= width) return text;
	if (width === 1) return "…";

	return `${characters.slice(0, width - 1).join("")}…`;
};

const fitStyledText = (text: string, width: number): string =>
	plainWidth(text) <= width ? text : truncatePlainText(stripAnsi(text), width);

const estimateTextTokens = (text: string): number => Math.ceil(text.length / CHARACTERS_PER_TOKEN);

const formatTokens = (count: number): string => {
	const value = Math.max(0, Math.round(count));

	if (value < 1000) return String(value);
	if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
	if (value < 1000000) return `${Math.round(value / 1000)}k`;
	if (value < 10000000) return `${(value / 1000000).toFixed(1)}M`;

	return `${Math.round(value / 1000000)}M`;
};

const ansiColor = (mode: 38 | 48, hex: string, text: string): string => {
	const value = Number.parseInt(hex.replace(/^#/, ""), 16);
	const red = (value >> 16) & 0xff;
	const green = (value >> 8) & 0xff;
	const blue = value & 0xff;
	const reset = mode === 38 ? 39 : 49;

	return `\x1b[${mode};2;${red};${green};${blue}m${text}\x1b[${reset}m`;
};

const foreground = (hex: string, text: string): string => ansiColor(38, hex, text);

const background = (hex: string, text: string): string => ansiColor(48, hex, text);

const centeredText = (text: string, width: number): string => {
	const textWidth = plainWidth(text);
	if (textWidth > width) return " ".repeat(width);

	const left = Math.floor((width - textWidth) / 2);
	const right = width - textWidth - left;

	return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object";

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

const chooseLabel = (labels: readonly string[], width: number): string => {
	for (const label of labels) {
		if (plainWidth(label) <= width) return label;
	}

	return "";
};

const renderUsedSegment = (labels: readonly string[], color: string, width: number): string => {
	if (width <= 0) return "";

	const label = chooseLabel(labels, width);
	const text = label.length > 0 ? foreground(USED_SEGMENT_TEXT, centeredText(label, width)) : " ".repeat(width);

	return background(color, text);
};

const writeText = (target: string[], text: string, start: number): void => {
	for (const [offset, character] of Array.from(text).entries()) {
		const index = start + offset;
		if (index >= 0 && index < target.length) target[index] = character;
	}
};

const chooseRightAlignedText = (options: readonly string[], width: number, blockedUntil: number): string => {
	for (const option of options) {
		const start = width - plainWidth(option);
		if (start > blockedUntil) return option;
	}

	return "";
};

const renderFreeSegment = (options: readonly string[], width: number): string => {
	if (width <= 0) return "";

	const content = Array.from({ length: width }, () => " ");
	const label = chooseLabel(FREE_SEGMENT_LABELS, width);
	const labelStart = Math.max(0, Math.floor((width - plainWidth(label)) / 2));
	const labelEnd = label.length > 0 ? labelStart + plainWidth(label) : -1;
	const rightText = chooseRightAlignedText(options, width, labelEnd);

	writeText(content, label, labelStart);
	writeText(content, rightText, width - plainWidth(rightText));

	return background(FREE_SEGMENT_FILL, foreground(FREE_SEGMENT_TEXT, content.join("")));
};

const allocateBarColumns = (values: readonly number[], width: number): readonly number[] => {
	const visibleUsedSegments = USED_SEGMENTS
		.map((_, index) => index)
		.filter((index) => (values[index] ?? 0) > 0);

	if (visibleUsedSegments.length === 0 || visibleUsedSegments.length >= width) {
		return allocateProportionally(values, width);
	}

	const minimumColumns = Array.from({ length: values.length }, () => 0);

	for (const index of visibleUsedSegments) {
		minimumColumns[index] = 1;
	}

	const remainingColumns = allocateProportionally(values, width - visibleUsedSegments.length);

	return minimumColumns.map((minimum, index) => minimum + (remainingColumns[index] ?? 0));
};

const renderContextBar = (snapshot: ContextSnapshot, width: number, freeTextOptions: readonly string[]): string => {
	const freeTokens = Math.max(0, snapshot.contextWindow - snapshot.usedTokens);
	const values = [...USED_SEGMENTS.map((segment) => snapshot.segments[segment.key]), freeTokens];
	const columns = allocateBarColumns(values, width);
	const usedSegments = USED_SEGMENTS
		.map((segment, index) => renderUsedSegment(segment.labels, segment.color, columns[index] ?? 0))
		.join("");
	const freeWidth = columns[USED_SEGMENTS.length] ?? 0;

	return `${usedSegments}${renderFreeSegment(freeTextOptions, freeWidth)}`;
};

const renderContextLine = (snapshot: ContextSnapshot, width: number, theme: Theme): string => {
	if (snapshot.contextWindow <= 0) return fitStyledText(theme.fg("dim", "ctx no model"), width);

	const prefix = snapshot.usageIsEstimated ? "~" : "";
	const percent = `${prefix}${((snapshot.usedTokens / snapshot.contextWindow) * 100).toFixed(1)}%`;
	const total = `${prefix}${formatTokens(snapshot.usedTokens)}/${formatTokens(snapshot.contextWindow)}`;
	const free = formatTokens(snapshot.contextWindow - snapshot.usedTokens);

	return renderContextBar(snapshot, width, [
		`ctx ${total} ${percent} ${free}`,
		`${total} ${percent} ${free}`,
		`${total} ${percent}`,
		percent,
	]);
};

const updateUi = (ctx: ExtensionContext, messages: readonly unknown[] = sessionMessages(ctx)): void => {
	if (!ctx.hasUI) return;

	const snapshot = makeContextSnapshot(ctx, messages);
	ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
		render: (width: number) => [renderContextLine(snapshot, width, ctx.ui.theme ?? theme)],
		invalidate: () => {},
	}), { placement: "belowEditor" });
};

export default function nanoContext(pi: ExtensionAPI): void {
	let activeContext: ExtensionContext | undefined;
	let resizeListening = false;

	const refreshFromSession = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		updateUi(ctx);
	};

	const refreshFromTerminalSize = (): void => {
		if (activeContext) updateUi(activeContext);
	};

	const startResizeListener = (): void => {
		if (resizeListening) return;
		process.stdout.on("resize", refreshFromTerminalSize);
		resizeListening = true;
	};

	pi.on("session_start", (_event, ctx) => {
		startResizeListener();
		refreshFromSession(ctx);
	});

	pi.on("context", (event, ctx) => {
		activeContext = ctx;
		updateUi(ctx, event.messages as readonly unknown[]);
	});

	pi.on("agent_end", (_event, ctx) => refreshFromSession(ctx));
	pi.on("model_select", (_event, ctx) => refreshFromSession(ctx));
	pi.on("thinking_level_select", (_event, ctx) => refreshFromSession(ctx));
	pi.on("session_compact", (_event, ctx) => refreshFromSession(ctx));
	pi.on("session_tree", (_event, ctx) => refreshFromSession(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_KEY, undefined, { placement: "belowEditor" });
		activeContext = undefined;
		if (resizeListening) {
			process.stdout.off("resize", refreshFromTerminalSize);
			resizeListening = false;
		}
	});
}
