import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { installThinkingMessageStyle } from "../src/thinking-message.ts";

const stripAnsi = (text: string): string =>
	text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("Thought trail keeps the latest lines visible and ends at the newest line", () => {
	initTheme("dark");
	const thinking = Array.from({ length: 20 }, (_, index) => `thought-${String(index + 1).padStart(2, "0")}`).join("\n");
	const message = {
		role: "assistant",
		content: [{ type: "thinking", thinking }],
		stopReason: "stop",
		timestamp: Date.now(),
	} as never;
	const theme = {
		italic: (text: string) => text,
	} as unknown as Theme;
	const cleanup = installThinkingMessageStyle(() => theme);

	try {
		const component = new AssistantMessageComponent(message);
		component.updateContent(message);
		const lines = component.render(160).map(stripAnsi);
		const thoughtLines = lines.filter((line) => /thought-\d+/.test(line));

		assert.equal(thoughtLines.length, 16);
		assert.ok(!thoughtLines.some((line) => line.includes("thought-01")));
		assert.ok(thoughtLines.some((line) => line.includes("thought-05")));
		assert.ok(thoughtLines.some((line) => line.includes("thought-20")));
		assert.match(lines.find((line) => line.includes("more")) ?? "", /… \+4 more/);
		assert.match(thoughtLines.at(-1) ?? "", /thought-20/);
	} finally {
		cleanup();
	}
});
