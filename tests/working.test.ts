import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import installWorking from "../src/working.ts";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type EntryRenderer = (entry: { data?: { elapsedMs?: unknown } }, options: unknown, theme: Theme) => Component;

test("working extension keeps native spinner frames and records elapsed transcript", () => {
	const handlers = new Map<string, Handler[]>();
	const indicators: Array<{ frames?: string[]; intervalMs?: number } | undefined> = [];
	const messages: Array<string | undefined> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	let renderer: EntryRenderer | undefined;

	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerEntryRenderer(_type: string, value: EntryRenderer) {
			renderer = value;
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWorkingIndicator: (value?: { frames?: string[]; intervalMs?: number }) => indicators.push(value),
			setWorkingMessage: (value?: string) => messages.push(value),
		},
	} as unknown as ExtensionContext;
	const emit = (name: string) => {
		for (const handler of handlers.get(name) ?? []) handler({ type: name }, ctx);
	};

	installWorking(pi);
	emit("session_start");
	const indicator = indicators.at(-1);
	assert.equal(indicator?.intervalMs, 80);
	assert.deepEqual(indicator?.frames?.map(stripAnsi), BRAILLE_FRAMES);

	emit("agent_start");
	try {
		assert.match(stripAnsi(messages.at(-1) ?? ""), /^Working \(\d+s · esc to interrupt\)$/);
	} finally {
		emit("agent_settled");
	}

	assert.equal(messages.at(-1), undefined);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]?.type, "pi-jielumoon-elapsed");
	assert.ok(renderer);
	const transcript = renderer({ data: { elapsedMs: 7_000 } }, {}, ctx.ui.theme).render(80).join("\n");
	assert.equal(stripAnsi(transcript).trimEnd(), "  Worked for 7s");
});
