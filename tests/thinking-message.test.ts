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

test("思考标签只替换思考组件，保留同名正文和代码行", () => {
	initTheme("dark");
	const cleanup = installThinkingMessageStyle(() => ({ italic: (text: string) => text }) as Theme);
	try {
		for (const hideThinking of [false, true]) {
			const message = {
				role: "assistant", stopReason: "stop", timestamp: 0,
				content: [
					{ type: "text", text: "Thinking..." },
					{ type: "thinking", thinking: "private reasoning" },
					{ type: "text", text: "Thought\n\n```text\nThinking...\n```" },
				],
			} as never;
			const component = new AssistantMessageComponent(message, hideThinking);
			const lines = component.render(80).map(stripAnsi);
			assert.ok(lines.some((line) => line.trim() === "Thinking..."));
			assert.ok(lines.some((line) => line.trim() === "Thought"));
			assert.equal(lines.filter((line) => line.includes("Thinking...")).length, 2);
			assert.equal(lines.some((line) => line.trim() === "✦ Thought"), hideThinking);
		}
	} finally {
		cleanup();
	}
});

test("Thought trail 在零 padding 和默认 padding 下保留满行文本", () => {
	initTheme("dark");
	const cleanup = installThinkingMessageStyle(() => ({ italic: (text: string) => text }) as Theme);
	try {
		const thinking = "abcdefghijklmnopqrstuvwxyzABCDEFGH";
		for (const padding of [0, 1]) {
			const component = new AssistantMessageComponent({
				role: "assistant", content: [{ type: "thinking", thinking }], stopReason: "stop", timestamp: 0,
			} as never, false, undefined, undefined, padding);
			const body = component.render(40).map(stripAnsi).filter((line) => line.trim() && !line.includes("Thought trail"));
			assert.equal(body.map((line) => line.slice(7).trimEnd()).join(""), thinking);
		}
	} finally {
		cleanup();
	}
});
