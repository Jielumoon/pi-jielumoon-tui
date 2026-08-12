import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { patchReadmapTool } from "../src/readmap-renderers/index.ts";
import {
	EditCallComponent,
	editStreamInput,
	renderEditPreviewLines,
} from "../src/readmap-renderers/edit-stream.ts";
import type { RenderPresentation } from "../src/readmap-renderers/presentation.ts";

// 测试基线固定为 color 模式：宿主终端的 NO_COLOR/TERM 不得改变断言结果。
process.env.PI_READMAP_RENDER_MODE = "color";
delete process.env.NO_COLOR;

const stripAnsi = (text: string): string =>
	text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const colorPresentation: RenderPresentation = { mode: "color", diagnostics: false, theme };

type MockTool = {
	name: string;
	execute: (...args: unknown[]) => unknown;
	parameters: { kind: string };
	description: string;
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
	renderShell?: "default" | "self";
	[key: symbol]: unknown;
};

function makeEditTool(): MockTool {
	return {
		name: "edit",
		execute: () => ({ content: [{ type: "text", text: "ok" }] }),
		parameters: { kind: "object" },
		description: "edit tool",
		renderCall: () => ({ render: () => ["old-call"] }),
		renderResult: () => ({ render: () => ["old-result"] }),
	};
}

function withEnv<T>(name: string, value: string | undefined, run: () => T): T {
	const previous = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	}
}

type CallComponent = {
	render: (width: number) => string[];
	advanceAnimation: () => boolean;
	stop: () => void;
};

test("editStreamInput flattens every readmap op variant", () => {
	const input = editStreamInput({
		path: "src/app.ts",
		edits: [
			{ set_line: { anchor: "5:abc", new_text: "const x = 1;" } },
			{ replace_lines: { start_anchor: "7:bcd", end_anchor: "9:cde", new_text: "one\ntwo" } },
			{ insert_after: { anchor: "12:def", new_text: "appended" } },
			{ replace: { old_text: "before", new_text: "after", all: true } },
			{ replace_symbol: { symbol: "renderThing", new_body: "function renderThing() {}" } },
		],
	}, colorPresentation);
	assert.equal(input.path, "src/app.ts");
	assert.equal(input.editCount, 5);
	const byKind = (kind: string): string[] =>
		input.lines.filter((line) => line.kind === kind).map((line) => line.text);
	assert.deepEqual(byKind("label"), [
		"set_line @ 5:abc",
		"replace_lines @ 7:bcd–9:cde",
		"insert_after @ 12:def",
		"replace",
		"replace_symbol @ renderThing",
	]);
	assert.deepEqual(byKind("remove"), ["before"]);
	assert.deepEqual(byKind("add"), [
		"const x = 1;",
		"one",
		"two",
		"appended",
		"after",
		"function renderThing() {}",
	]);
});

test("editStreamInput tolerates partial, legacy, and malformed args", () => {
	// 流式早期：edits 数组里还只有空对象。
	const partial = editStreamInput({ path: "a.ts", edits: [{}] }, colorPresentation);
	assert.equal(partial.editCount, 0);
	assert.deepEqual(partial.lines, []);

	// replace 的 old_text 已开始、new_text 未出现：只有红行。
	const halfway = editStreamInput(
		{ path: "a.ts", edits: [{ replace: { old_text: "legacy li" } }] },
		colorPresentation,
	);
	assert.deepEqual(halfway.lines, [
		{ kind: "label", text: "replace" },
		{ kind: "remove", text: "legacy li" },
	]);

	// 宿主 pi 风格 oldText/newText 与 readmap 顶层遗留字段。
	const hostStyle = editStreamInput(
		{ path: "a.ts", edits: [{ oldText: "x", newText: "y" }] },
		colorPresentation,
	);
	assert.deepEqual(hostStyle.lines.map((line) => line.kind), ["label", "remove", "add"]);
	const legacyTop = editStreamInput({ path: "a.ts", old_text: "x", new_text: "y" }, colorPresentation);
	assert.equal(legacyTop.editCount, 1);

	// edits 是 JSON 字符串（个别模型）：不展示正文，等结果态。
	const stringEdits = editStreamInput(
		{ path: "a.ts", edits: "[{\"replace\":{\"old_text\":\"x\",\"new_text\":\"y\"}}]" },
		colorPresentation,
	);
	assert.equal(stringEdits.editCount, 0);

	// 锚点含控制序列与换行：净化并压成单行。
	const hostile = editStreamInput(
		{ path: "a.ts", edits: [{ set_line: { anchor: "5:ab\x1b[31mc\nx", new_text: "v" } }] },
		colorPresentation,
	);
	assert.equal(hostile.lines[0]?.text, "set_line @ 5:abc x");

	// 个别模型把锚点发成数字：容忍并转成文本。
	const numeric = editStreamInput(
		{ path: "a.ts", edits: [{ set_line: { anchor: 5, new_text: "v" } }] },
		colorPresentation,
	);
	assert.equal(numeric.lines[0]?.text, "set_line @ 5");
});

test("edit call animates incrementally and flushes when args complete", () => {
	const tool = makeEditTool();
	patchReadmapTool(tool, { editAnimation: true });
	let invalidations = 0;
	const args = { path: "src/live.ts", edits: [{ replace: { old_text: "old", new_text: "new" } }] };
	const component = tool.renderCall?.(args, theme, {
		argsComplete: false,
		isPartial: true,
		invalidate: () => invalidations++,
	}) as CallComponent;
	assert.ok(component instanceof EditCallComponent, "edit call should route to EditCallComponent");

	const initialLines = component.render(80);
	const initial = stripAnsi(initialLines.join("\n"));
	assert.match(initial, /Edit.*live\.ts.*1 edit/);
	assert.equal(initialLines.length, 1, "nothing revealed yet: header only, no cursor row");
	assert.doesNotMatch(initial, /replace/, "label text must not be revealed before animation advances");

	assert.equal(component.advanceAnimation(), true, "backlog should keep the animation alive");
	assert.equal(invalidations, 1, "advance must invalidate the row");
	// 目标 15 字符、追赶 6 tick：一次推进揭示 ceil(15/6)=3 个字符。
	const advanced = stripAnsi(component.render(80).join("\n"));
	assert.match(advanced, /┄ rep$/, "label prefix should reveal progressively");
	assert.doesNotMatch(advanced, /▏/, "reveal must not draw a cursor");

	const complete = tool.renderCall?.(args, theme, {
		argsComplete: true,
		isPartial: true,
		lastComponent: component as never,
	}) as CallComponent;
	const completeText = stripAnsi(complete.render(80).join("\n"));
	assert.match(completeText, /replace/);
	assert.match(completeText, /- old/);
	assert.match(completeText, /\+ new/);
	assert.doesNotMatch(completeText, /▏/, "flushed edit must not draw a cursor");
	component.stop();
});

test("edit stream tints labels, removals, and additions", () => {
	const colors: Array<{ color: string; text: string }> = [];
	const recordingTheme = {
		fg: (color: string, text: string) => {
			colors.push({ color, text });
			return text;
		},
		bold: (text: string) => text,
	};
	const tool = makeEditTool();
	patchReadmapTool(tool, { editAnimation: false });
	const component = tool.renderCall?.(
		{ path: "src/tint.ts", edits: [{ replace: { old_text: "gone", new_text: "fresh" } }] },
		recordingTheme,
		{ argsComplete: false, isPartial: true },
	) as CallComponent;
	component.render(80);
	assert.ok(
		colors.some((part) => part.color === "muted" && part.text.includes("replace")),
		"op label should use muted color",
	);
	assert.ok(
		colors.some((part) => part.color === "toolDiffRemoved" && part.text === "gone"),
		"old text should use toolDiffRemoved",
	);
	assert.ok(
		colors.some((part) => part.color === "toolDiffAdded" && part.text === "fresh"),
		"new text should use toolDiffAdded",
	);
	assert.ok(
		colors.some((part) => part.color === "syntaxType" && part.text === "src/tint.ts"),
		"edit path should keep syntaxType header color",
	);
});

test("edit call keeps an eight-row tail collapsed and expands fully", () => {
	const tool = makeEditTool();
	patchReadmapTool(tool, { editAnimation: false });
	const newText = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n");
	const args = { path: "src/tail.ts", edits: [{ replace: { old_text: "old-body", new_text: newText } }] };

	const collapsed = tool.renderCall?.(args, theme, {
		argsComplete: false,
		isPartial: true,
		expanded: false,
	}) as CallComponent;
	const collapsedLines = collapsed.render(80);
	const collapsedText = stripAnsi(collapsedLines.join("\n"));
	assert.equal(collapsedLines.length, 9, "collapsed edit keeps header plus eight tail rows");
	assert.match(collapsedText, /line-12/);
	assert.match(collapsedText, /line-5/);
	assert.doesNotMatch(collapsedText, /line-4(?!\d)/, "rows before the tail stay hidden");
	assert.doesNotMatch(collapsedText, /old-body/, "earlier removal rows scroll out of the tail");
	assert.match(collapsedText, /Ctrl\+O/, "truncated tail advertises expansion");

	const expanded = tool.renderCall?.(args, theme, {
		argsComplete: false,
		isPartial: true,
		expanded: true,
		lastComponent: collapsed as never,
	}) as CallComponent;
	const expandedText = stripAnsi(expanded.render(80).join("\n"));
	assert.match(expandedText, /replace/);
	assert.match(expandedText, /old-body/);
	assert.match(expandedText, /line-1(?!\d)/);
	assert.match(expandedText, /line-12/);

	for (const line of expanded.render(24)) {
		assert.ok(visibleWidth(line) <= 24, `line wider than 24: ${JSON.stringify(stripAnsi(line))}`);
	}
});

test("edit reveal clamps when streaming args backtrack", () => {
	const component = new EditCallComponent();
	const presentation = colorPresentation;
	component.update(
		{ path: "a.ts", edits: [{ replace: { old_text: "stable prefix plus more" } }] },
		presentation,
		{ argsComplete: false, isPartial: true },
		{ editAnimation: true },
	);
	while (component.advanceAnimation()) {
		// 推进到没有积压为止。
	}
	assert.match(stripAnsi(component.render(80).join("\n")), /stable prefix plus more/);

	// 部分 JSON 解析短暂回退：目标不再是已揭示内容的超集。
	component.update(
		{ path: "a.ts", edits: [{ replace: { old_text: "stable prefix" } }] },
		presentation,
		{ argsComplete: false, isPartial: true },
		{ editAnimation: true },
	);
	const text = stripAnsi(component.render(80).join("\n"));
	assert.match(text, /stable prefix/);
	assert.doesNotMatch(text, /plus more/, "reveal must clamp back to the common prefix");
	component.stop();
});

test("edit call is static in plain and screen-reader modes", () => {
	const tool = makeEditTool();
	patchReadmapTool(tool, { editAnimation: true });
	const args = { path: "notes.txt", edits: [{ replace: { old_text: "first", new_text: "second" } }] };

	const plain = withEnv("PI_READMAP_RENDER_MODE", "plain", () => tool.renderCall?.(
		args,
		theme,
		{ argsComplete: false, isPartial: true },
	)) as CallComponent;
	const plainText = plain.render(80).join("\n");
	assert.match(plainText, /replace/);
	assert.match(plainText, /- first/);
	assert.match(plainText, /\+ second/);
	assert.doesNotMatch(plainText, /▏|\x1b\[/, "plain mode must not animate or color");

	const reader = withEnv("PI_READMAP_RENDER_MODE", "screen-reader", () => tool.renderCall?.(
		args,
		theme,
		{ argsComplete: false, isPartial: true },
	)) as CallComponent;
	const readerText = reader.render(80).join("\n");
	assert.match(readerText, /edit: replace/);
	assert.match(readerText, /removed: first/);
	assert.match(readerText, /added: second/);
	assert.doesNotMatch(readerText, /▏/, "screen-reader mode must not animate");
});

test("edit call with animation disabled stays static and completed calls clear", () => {
	const tool = makeEditTool();
	patchReadmapTool(tool, { editAnimation: false });
	const args = { path: "src/static.ts", edits: [{ replace: { old_text: "aa", new_text: "bb" } }] };
	const component = tool.renderCall?.(args, theme, {
		argsComplete: false,
		isPartial: true,
	}) as CallComponent;
	const text = stripAnsi(component.render(80).join("\n"));
	assert.match(text, /- aa/);
	assert.match(text, /\+ bb/);
	assert.doesNotMatch(text, /▏/, "disabled animation must not show a cursor");
	assert.equal(component.advanceAnimation(), false, "disabled animation must not advance");

	const done = tool.renderCall?.(args, theme, {
		isPartial: false,
		lastComponent: component as never,
	}) as CallComponent;
	assert.deepEqual(done.render(80), [], "finished call clears the pending preview");
});

test("empty edit stream renders no body while waiting for ops", () => {
	const preview = renderEditPreviewLines("", [], colorPresentation, 80, false);
	assert.deepEqual(preview.lines, []);
	assert.equal(preview.truncated, false);
	const expanded = renderEditPreviewLines("", [], colorPresentation, 80, true);
	assert.deepEqual(expanded.lines, []);
});

test("edit stream bounds a huge single line in the collapsed tail", () => {
	const component = new EditCallComponent();
	component.update(
		{
			path: "src/huge.ts",
			edits: [{ replace: { old_text: "x", new_text: `START${"y".repeat(200_000)}END` } }],
		},
		colorPresentation,
		{ argsComplete: true, isPartial: true, expanded: false },
		{ editAnimation: false },
	);
	const start = performance.now();
	const lines = component.render(80);
	const elapsedMs = performance.now() - start;
	const text = stripAnsi(lines.join("\n"));
	assert.equal(lines.length, 9, "collapsed huge edit keeps header plus eight rows");
	assert.match(text, /END/);
	assert.doesNotMatch(text, /START/);
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 80, `line wider than 80: ${visibleWidth(line)}`);
	}
	assert.ok(elapsedMs < 2_000, `200k folded edit took ${Math.round(elapsedMs)}ms`);
});
