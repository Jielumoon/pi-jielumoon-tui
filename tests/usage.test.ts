import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionUsageCollector } from "../src/footer/usage.ts";

function assistantEntry(
	id: string,
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	cost: number,
): SessionEntry {
	return {
		id,
		timestamp: 0,
		type: "message",
		message: {
			role: "assistant",
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite,
				cost: { total: cost },
			},
		},
	} as unknown as SessionEntry;
}

function contextFor(entries: SessionEntry[]): ExtensionContext {
	return {
		sessionManager: { getEntries: () => entries },
	} as unknown as ExtensionContext;
}

test("usage collector only accumulates appended entries", () => {
	const entries = [assistantEntry("first", 100, 20, 50, 0, 0.01)];
	const collector = new SessionUsageCollector();
	const ctx = contextFor(entries);

	assert.deepEqual(collector.collect(ctx), {
		input: 100,
		output: 20,
		cacheRead: 50,
		cacheWrite: 0,
		cost: 0.01,
		cacheHitRate: 50 / 150 * 100,
	});

	entries.push(assistantEntry("second", 200, 30, 0, 20, 0.02));
	assert.deepEqual(collector.collect(ctx), {
		input: 300,
		output: 50,
		cacheRead: 50,
		cacheWrite: 20,
		cost: 0.03,
		cacheHitRate: 50 / 370 * 100,
	});
});

test("usage collector resets when session history is replaced", () => {
	const entries = [assistantEntry("old", 100, 20, 0, 0, 0.01)];
	const collector = new SessionUsageCollector();
	const ctx = contextFor(entries);

	collector.collect(ctx);
	entries.splice(0, entries.length, assistantEntry("new", 40, 8, 20, 0, 0.005));

	assert.deepEqual(collector.collect(ctx), {
		input: 40,
		output: 8,
		cacheRead: 20,
		cacheWrite: 0,
		cost: 0.005,
		cacheHitRate: 20 / 60 * 100,
	});
});
