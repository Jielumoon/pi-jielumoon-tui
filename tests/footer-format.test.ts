import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatCwd, formatDuration, formatTokens, layoutSegments } from "../src/footer/format.ts";
import { renderFooter } from "../src/footer/render.ts";
import {
	DEFAULT_FOOTER_SETTINGS,
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
	context: "C",
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
	context: { percent: 21.5, contextWindow: 128_000 },
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


test("subscription quota follows subscription cost before elapsed", () => {
	const renderData = {
		branch: "main",
		extensionStatuses: new Map<string, string>(),
		subscriptionUsage: quotaState,
	};
	const settings = structuredClone(DEFAULT_FOOTER_SETTINGS);

	const wideLines = renderFooter(quotaSnapshot, settings, renderData, 160, theme, icons);
	const wideMetricLine = wideLines.find((line) => line.includes("5h 72%")) ?? "";
	assert.match(wideMetricLine, /\$ 0\.024 sub · 5h 72% ↻ 1h · 7d 41% ↻ 4d · T 1m12s/);
	assert.ok(wideMetricLine.indexOf("5h 72%") < wideMetricLine.indexOf("openai-codex"));
	assert.equal(visibleWidth(wideMetricLine), 160);

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

test("planning status stays on the right and can be hidden", () => {
	const settings = structuredClone(DEFAULT_FOOTER_SETTINGS);
	const renderData = {
		branch: "main",
		extensionStatuses: new Map([
			["usage", "usage ready"],
			["planning-with-files", "7/7 phases complete"],
		]),
	};
	const lines = renderFooter(snapshot, settings, renderData, 80, theme, icons);
	const statusLine = lines.at(-1) ?? "";

	assert.ok(statusLine.endsWith("7/7 phases complete"));
	assert.match(statusLine, /usage ready/);
	assert.equal(visibleWidth(statusLine), 80);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));

	settings.planning = false;
	const hiddenLines = renderFooter(snapshot, settings, renderData, 80, theme, icons);
	assert.doesNotMatch(hiddenLines.join("\n"), /7\/7 phases complete/);
});
