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
	assert.equal(visibleWidth(statusLine), 80);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));

	settings.planning = false;
	const hiddenLines = renderFooter(snapshot, settings, renderData, 80, theme, icons);
	assert.doesNotMatch(hiddenLines.join("\n"), /7\/7 phases complete/);
});
