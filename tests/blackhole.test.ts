import assert from "node:assert/strict";
import test from "node:test";
import {
	blackholeMetricTone,
	formatBlackholeCooldowns,
	formatBlackholeMetric,
	summarizeBlackholeBranch,
} from "../src/footer/blackhole.ts";
import type { BlackholeEntry, BlackholeStatus } from "../src/footer/types.ts";

/** custom_message 文本按 length/4 估算，40 个字符恰好 10 token。 */
const TEN_TOKEN_TEXT = "x".repeat(40);

function message(id: string, text = TEN_TOKEN_TEXT): BlackholeEntry {
	return { type: "custom_message", id, content: text };
}

function observations(coversUpToId: string, items: Array<{ id: string; tokenCount: number }>): BlackholeEntry {
	return {
		type: "custom",
		customType: "om.observations.recorded",
		data: { coversUpToId, observations: items },
	};
}

test("summarize counts all source tokens when nothing is covered", () => {
	const summary = summarizeBlackholeBranch([message("a"), message("b"), message("c")]);
	assert.equal(summary.observerTokens, 30, "observer should see all uncovered source tokens");
	assert.equal(summary.reflectorTokens, 30, "reflector should see all uncovered source tokens");
	assert.equal(summary.compactionTokens, 30, "compaction should see all uncovered source tokens");
	assert.equal(summary.poolTokens, 0, "pool is empty without observations");
});

test("summarize advances observer coverage and accumulates the observation pool", () => {
	const entries: BlackholeEntry[] = [
		message("a"),
		message("b"),
		observations("a", [{ id: "o1", tokenCount: 5 }, { id: "o2", tokenCount: 7 }]),
		message("c"),
	];
	const summary = summarizeBlackholeBranch(entries);
	assert.equal(summary.observerTokens, 20, "only b and c stay uncovered after coversUpToId=a");
	assert.equal(summary.reflectorTokens, 30, "reflections were never recorded");
	assert.equal(summary.poolTokens, 12, "pool sums recorded observation tokenCounts");
});

test("summarize removes dropped observations from the pool and dedupes ids", () => {
	const entries: BlackholeEntry[] = [
		message("a"),
		observations("a", [{ id: "o1", tokenCount: 5 }, { id: "o2", tokenCount: 7 }]),
		observations("a", [{ id: "o1", tokenCount: 999 }]),
		{
			type: "custom",
			customType: "om.observations.dropped",
			data: { observationIds: ["o2"] },
		},
	];
	const summary = summarizeBlackholeBranch(entries);
	assert.equal(summary.poolTokens, 5, "o2 dropped, o1 keeps its first recorded tokenCount");
});

test("summarize honors reflection coverage independently of observer coverage", () => {
	const entries: BlackholeEntry[] = [
		message("a"),
		message("b"),
		{
			type: "custom",
			customType: "om.reflections.recorded",
			data: { coversUpToId: "b", reflections: [{ id: "r1" }] },
		},
		message("c"),
	];
	const summary = summarizeBlackholeBranch(entries);
	assert.equal(summary.reflectorTokens, 10, "only c stays uncovered for the reflector");
	assert.equal(summary.observerTokens, 30, "observer coverage is untouched by reflections");
});

test("summarize anchors compaction at firstKeptEntryId when present", () => {
	const withoutAnchor = summarizeBlackholeBranch([
		message("a"),
		{ type: "compaction" },
		message("b"),
	]);
	assert.equal(withoutAnchor.compactionTokens, 10, "without anchor only entries after the compaction count");

	const withAnchor = summarizeBlackholeBranch([
		message("a"),
		message("b"),
		{ type: "compaction", firstKeptEntryId: "b" },
	]);
	assert.equal(withAnchor.compactionTokens, 10, "with anchor the kept entry itself stays counted");
});

test("summarize caches immutable entry estimates but re-reads the streaming tail", () => {
	const settled = message("a");
	const tail = message("z");
	const first = summarizeBlackholeBranch([settled, tail]);
	assert.equal(first.observerTokens, 20, "baseline estimate for two ten-token entries");

	// 追加后不可变是缓存前提：中途篡改 settled 条目不应改变结果（命中缓存）。
	settled.content = "y".repeat(400);
	const second = summarizeBlackholeBranch([settled, tail]);
	assert.equal(second.observerTokens, 20, "settled entries reuse the cached estimate");

	// 末尾条目可能仍在流式写入，必须每次重新估算。
	tail.content = "y".repeat(400);
	const third = summarizeBlackholeBranch([settled, tail]);
	assert.equal(third.observerTokens, 110, "the trailing entry is re-estimated every pass");
});

test("metric tone reflects pressure and disabled states", () => {
	const status = {
		compaction: "auto",
		memory: true,
	} as BlackholeStatus;
	assert.equal(blackholeMetricTone(status, 5, 10), "success");
	assert.equal(blackholeMetricTone(status, 7, 10), "warning");
	assert.equal(blackholeMetricTone(status, 10, 10), "error");
	assert.equal(blackholeMetricTone({ ...status, compaction: "off" }, 0, 10), "muted");
	assert.equal(blackholeMetricTone({ ...status, memory: false }, 0, 10), "muted");
});

test("cooldowns and metrics format compactly", () => {
	assert.equal(
		formatBlackholeCooldowns([
			{ stage: "observer", remainingMs: 90_000 },
			{ stage: "model", remainingMs: 3_900_000 },
		]),
		"CD·observer·2m CD·model·1h5m",
	);
	assert.equal(formatBlackholeMetric(1_500, 15_000), "1.5k/15k");
});
