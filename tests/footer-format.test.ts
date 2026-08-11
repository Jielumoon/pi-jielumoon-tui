import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatCwd, formatDuration, formatTokens, layoutSegments } from "../src/footer/format.ts";
import { renderFooter } from "../src/footer/render.ts";
import installNanoContext, { renderContextLine, type ContextSnapshot } from "../src/nano-context.ts";
import {
	DEFAULT_FOOTER_SETTINGS,
	FOOTER_SETTING_DEFINITIONS,
	type FooterSnapshot,
	type FooterTheme,
	type IconSet,
} from "../src/footer/types.ts";
import type { SubscriptionUsageState } from "../src/footer/subscription-usage.ts";

const theme: FooterTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

const icons: IconSet = {
	path: "P",
	branch: "B",
	session: "S",
	input: "I",
	output: "O",
	cacheRead: "R",
	cacheWrite: "W",
	cacheHit: "H",
	cost: "$",
	time: "T",
	model: "M",
	thinking: "K",
	blackhole: "BH",
};

const snapshot: FooterSnapshot = {
	cwd: "/home/jielumoon/opt/projects/pi-tui/pi-jielumoon",
	sessionName: "footer tests",
	sessionStartMs: 0,
	nowMs: 72_000,
	model: {
		provider: "openai",
		id: "gpt-5",
		reasoning: true,
		contextWindow: 128_000,
		usingOAuth: false,
	},
	thinkingLevel: "high",
	usage: {
		input: 1_200,
		output: 340,
		cacheRead: 800,
		cacheWrite: 100,
		cacheHitRate: 38.1,
		cost: 0.024,
	},
	blackhole: null,
};

const quotaSnapshot: FooterSnapshot = {
	...snapshot,
	model: { ...snapshot.model!, provider: "openai-codex", usingOAuth: true },
};

const quotaState: SubscriptionUsageState = {
	kind: "ready",
	modelIdentity: "openai-codex/gpt-5",
	usage: {
		providerId: "openai-codex",
		displayName: "Codex",
		capturedAt: quotaSnapshot.nowMs,
		windows: [
			{ label: "5h", usedPercent: 28, resetAt: new Date(quotaSnapshot.nowMs + 60 * 60 * 1000).toISOString() },
			{ label: "7d", usedPercent: 59, resetAt: new Date(quotaSnapshot.nowMs + 4 * 24 * 60 * 60 * 1000).toISOString() },
		],
		metrics: [],
		notes: [],
	},
};

test("formatters keep compact terminal-friendly labels", () => {
	assert.equal(formatTokens(999), "999");
	assert.equal(formatTokens(1_200), "1.2k");
	assert.equal(formatTokens(12_300), "12k");
	assert.equal(formatDuration(72_000), "1m12s");
	assert.equal(formatCwd("/home/baby/project", "/home/baby"), "~/project");
});

test("footer segments fit at narrow widths without overflowing", () => {
	const lines = layoutSegments(["context", "traffic", "cache", "cost"], " · ", 13);

	assert.ok(lines.length <= 2);
	assert.ok(lines.every((line) => visibleWidth(line) <= 13));
});

test("nano context uses a compact foreground gauge without full-width backgrounds", () => {
	const context: ContextSnapshot = {
		segments: { system: 8_000, prompt: 6_000, assistant: 5_000, thinking: 3_000, tools: 5_520 },
		usedTokens: 27_520,
		contextWindow: 128_000,
		usageIsEstimated: false,
	};
	for (const width of [18, 40, 60, 80, 120, 160]) {
		const line = renderContextLine(context, width, theme as never);
		assert.ok(visibleWidth(line) <= width);
		assert.doesNotMatch(line, /\x1b\[48;/);
		assert.match(line, /ctx/);
	}
	const wide = renderContextLine(context, 80, theme as never);
	assert.match(wide, /21\.5%/);
	assert.match(wide, /28k\/128k/);
	assert.ok(visibleWidth(wide) < 80);
});


test("nano context follows the shared Footer context setting", () => {
	type Handler = (event: { messages?: readonly unknown[] }, ctx: unknown) => void;
	type WidgetFactory = (tui: unknown, widgetTheme: unknown) => { render(width: number): string[] };
	const handlers = new Map<string, Handler>();
	let widgetFactory: WidgetFactory | undefined;
	const settings = { context: true };
	const pi = {
		on: (event: string, handler: Handler) => handlers.set(event, handler),
	};
	installNanoContext(pi as never, settings);
	const ctx = {
		hasUI: true,
		getSystemPrompt: () => "",
		getContextUsage: () => ({ tokens: 100, contextWindow: 1_000, percent: 10 }),
		model: { contextWindow: 1_000 },
		ui: {
			theme: theme as never,
			setWidget: (_key: string, factory: unknown) => {
				if (typeof factory === "function") widgetFactory = factory as WidgetFactory;
			},
		},
	};
	handlers.get("context")?.({ messages: [] }, ctx);
	assert.ok(widgetFactory);
	const widget = widgetFactory({}, theme);
	assert.equal(widget.render(80).length, 1);
	settings.context = false;
	assert.deepEqual(widget.render(80), []);
});

test("tool background setting defaults off and exposes the command alias", () => {
	const definition = FOOTER_SETTING_DEFINITIONS.find((item) => item.key === "toolBackground");
	assert.ok(definition);
	assert.equal(DEFAULT_FOOTER_SETTINGS.toolBackground, false);
	assert.deepEqual(definition.aliases, ["tool-bg"]);
});

test("footer omits an empty identity row when the selected model is unavailable", () => {
	const settings = structuredClone(DEFAULT_FOOTER_SETTINGS);
	Object.assign(settings, {
		path: false,
		traffic: false,
		cache: false,
		cost: false,
		elapsed: false,
		provider: false,
		model: true,
		thinking: false,
		blackhole: false,
		extensions: false,
		planning: false,
	});
	const lines = renderFooter(
		{ ...snapshot, model: null },
		settings,
		{ branch: null, extensionStatuses: new Map() },
		80,
		theme,
		icons,
	);
	assert.deepEqual(lines, []);
});


test("subscription quota follows subscription cost before elapsed", () => {
	const renderData = {
		branch: "main",
		extensionStatuses: new Map<string, string>(),
		subscriptionUsage: quotaState,
	};
	const settings = structuredClone(DEFAULT_FOOTER_SETTINGS);

	const wideLines = renderFooter(quotaSnapshot, settings, renderData, 160, theme, icons);
	const wideMetricLine = wideLines.find((line) => line.includes("5h 72%")) ?? "";
	assert.match(wideMetricLine, /\$ 0\.024 sub · 5h 72% ↻ 1h · 7d 41% ↻ 4d/);
	assert.ok(wideMetricLine.endsWith("T 1m12s"));
	assert.equal(visibleWidth(wideMetricLine), 160);
	assert.match(wideLines[0] ?? "", /P .*B main.*openai-codex.*M gpt-5/);
	assert.equal(visibleWidth(wideLines[0] ?? ""), 160);
	assert.doesNotMatch(wideLines.join("\n"), /C 21\.5%/);

	const mediumLines = renderFooter(quotaSnapshot, settings, renderData, 80, theme, icons);
	const mediumQuotaLine = mediumLines.find((line) => line.includes("5h 72%")) ?? "";
	assert.match(mediumQuotaLine, /5h 72%/);
	assert.equal(mediumQuotaLine, mediumQuotaLine.trimStart());
	assert.ok(mediumLines.every((line) => visibleWidth(line) <= 80));

	const staleLines = renderFooter(
		quotaSnapshot,
		settings,
		{ ...renderData, subscriptionUsage: { ...quotaState, modelIdentity: "anthropic/claude" } },
		80,
		theme,
		icons,
	);
	assert.doesNotMatch(staleLines.join("\n"), /5h 72%/);
});


test("footer keeps semantic colors for traffic, cache, cost, and healthy quota", () => {
	const colorCalls: Array<{ color: string; text: string }> = [];
	const recordingTheme: FooterTheme = {
		fg: (color, text) => {
			colorCalls.push({ color, text });
			return text;
		},
		bold: (text) => text,
	};
	const colorfulSnapshot: FooterSnapshot = {
		...quotaSnapshot,
		usage: {
			input: 748_000,
			output: 88_000,
			cacheRead: 25_000_000,
			cacheWrite: 0,
			cacheHitRate: 97,
			cost: 21.687,
		},
	};
	const colorfulQuota: SubscriptionUsageState = {
		...quotaState,
		usage: {
			...quotaState.usage,
			windows: [{ label: "7d", usedPercent: 18, resetAt: new Date(quotaSnapshot.nowMs + 6 * 24 * 60 * 60 * 1000).toISOString() }],
		},
	};
	const lines = renderFooter(
		colorfulSnapshot,
		structuredClone(DEFAULT_FOOTER_SETTINGS),
		{ branch: "main", extensionStatuses: new Map(), subscriptionUsage: colorfulQuota },
		160,
		recordingTheme,
		icons,
	);
	assert.match(lines.join("\n"), /I 748k O 88k.*R 25M H 97%.*\$ 21\.687 sub.*7d 82% ↻ 6d/);
	const usedColor = (color: string, text: string): boolean =>
		colorCalls.some((call) => call.color === color && call.text === text);
	assert.ok(usedColor("mdLink", "748k"));
	assert.ok(usedColor("success", "88k"));
	assert.ok(usedColor("syntaxOperator", "25M"));
	assert.ok(usedColor("success", "97%"));
	assert.ok(usedColor("warning", "21.687 sub"));
	assert.ok(usedColor("success", "82%"));
});


test("Blackhole stays visible whenever its snapshot is available", () => {
	const settings = structuredClone(DEFAULT_FOOTER_SETTINGS);
	const healthySnapshot: FooterSnapshot = {
		...snapshot,
		blackhole: {
			compaction: "auto",
			compactionEngine: "blackhole",
			memory: true,
			observerTokens: 1_000,
			observerThreshold: 15_000,
			reflectorTokens: 2_000,
			reflectorThreshold: 25_000,
			poolTokens: 500,
			poolThreshold: 20_000,
			compactionTokens: 3_000,
			compactionThreshold: 81_000,
			cooldowns: [],
		},
	};
	const renderData = { branch: "main", extensionStatuses: new Map<string, string>() };
	const lines = renderFooter(healthySnapshot, settings, renderData, 80, theme, icons);
	assert.match(lines.join("\n"), /BH auto.*O·.*R·.*P·/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));

	settings.blackhole = false;
	const hidden = renderFooter(healthySnapshot, settings, renderData, 80, theme, icons);
	assert.doesNotMatch(hidden.join("\n"), /BH auto/);
});

test("footer visual fixture stays bounded at 40/60/80/120/160 columns", () => {
	const settings = structuredClone(DEFAULT_FOOTER_SETTINGS);
	const renderData = {
		branch: "main",
		extensionStatuses: new Map<string, string>(),
		subscriptionUsage: quotaState,
	};
	for (const width of [40, 60, 80, 120, 160]) {
		const lines = renderFooter(quotaSnapshot, settings, renderData, width, theme, icons);
		assert.ok(lines.length >= 2);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		assert.match(lines[0] ?? "", /gpt-5/);
	}
});

test("quiet extension statuses stay hidden while active planning keeps the right anchor", () => {
	const settings = structuredClone(DEFAULT_FOOTER_SETTINGS);
	const quietData = {
		branch: "main",
		extensionStatuses: new Map([
			["usage", "usage ready"],
			["planning-with-files", "7/7 phases complete"],
		]),
	};
	const quietLines = renderFooter(snapshot, settings, quietData, 80, theme, icons);
	assert.doesNotMatch(quietLines.join("\n"), /usage ready|phases complete/);

	const activeData = {
		...quietData,
		extensionStatuses: new Map([
			["usage", "usage refreshing"],
			["planning-with-files", "Phase 2/4 implementing"],
		]),
	};
	const activeLines = renderFooter(snapshot, settings, activeData, 80, theme, icons);
	const statusLine = activeLines.at(-1) ?? "";
	assert.ok(statusLine.endsWith("Phase 2/4 implementing"));
	assert.match(statusLine, /usage refreshing/);
	assert.equal(visibleWidth(statusLine), 80);
	assert.ok(activeLines.every((line) => visibleWidth(line) <= 80));

	const warningTexts = [
		"usage not ready",
		"sync completed with errors",
		"cache idle: last request failed",
	];
	const warningLines = renderFooter(
		snapshot,
		settings,
		{ ...quietData, extensionStatuses: new Map(warningTexts.map((text, index) => [`warning-${index}`, text])) },
		160,
		theme,
		icons,
	);
	for (const warning of warningTexts) assert.match(warningLines.join("\n"), new RegExp(warning));

	settings.planning = false;
	const hiddenLines = renderFooter(snapshot, settings, activeData, 80, theme, icons);
	assert.doesNotMatch(hiddenLines.join("\n"), /Phase 2\/4 implementing/);
});
