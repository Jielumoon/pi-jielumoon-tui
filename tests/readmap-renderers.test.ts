import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import installReadmapRenderers, {
	DiffBodyComponent,
	READMAP_RENDERER_MARK,
	clampLine,
	patchReadmapTool,
	patchToolPayload,
} from "../src/readmap-renderers.ts";
import { installMessageBorders } from "../src/message-borders.ts";

const stripAnsi = (text: string): string =>
	text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

type MockTool = {
	name: string;
	execute: (...args: unknown[]) => unknown;
	parameters: { kind: string };
	description: string;
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
	[key: symbol]: unknown;
};

function makeTool(name: string): MockTool {
	const execute = () => ({ content: [{ type: "text", text: "ok" }] });
	return {
		name,
		execute,
		parameters: { kind: "object" },
		description: `${name} tool`,
		renderCall: () => ({ render: () => ["old-call"] }),
		renderResult: () => ({ render: () => ["old-result"] }),
	};
}

function assertNoOverflow(lines: string[], width: number): void {
	for (const line of lines) {
		assert.ok(
			visibleWidth(line) <= width,
			`line wider than ${width}: ${JSON.stringify(stripAnsi(line))} (${visibleWidth(line)})`,
		);
	}
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

test("patchToolPayload ignores bad payload and skips non-target tools", () => {
	assert.deepEqual(patchToolPayload(undefined), []);
	assert.deepEqual(patchToolPayload(null), []);
	assert.deepEqual(patchToolPayload("x"), []);
	assert.deepEqual(patchToolPayload({ grep: makeTool("grep") }), []);
});

test("patch is idempotent and keeps execute/parameters references", () => {
	const tool = makeTool("read");
	const execute = tool.execute;
	const parameters = tool.parameters;
	const description = tool.description;

	assert.equal(patchReadmapTool(tool), true);
	assert.equal(patchReadmapTool(tool), false);
	assert.equal(tool[READMAP_RENDERER_MARK], true);
	assert.equal(tool.execute, execute);
	assert.equal(tool.parameters, parameters);
	assert.equal(tool.description, description);
	assert.notEqual(typeof tool.renderCall, "undefined");
	assert.notEqual(typeof tool.renderResult, "undefined");
});

test("install listens for hashline executors and patches bash via registerTool", () => {
	const handlers = new Map<string, Array<(event: unknown) => unknown>>();
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const registered: MockTool[] = [];

	const pi = {
		on(event: string, handler: (event: unknown) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				eventHandlers.set(channel, [...(eventHandlers.get(channel) ?? []), handler]);
				return () => undefined;
			},
			emit(channel: string, data: unknown) {
				for (const handler of eventHandlers.get(channel) ?? []) handler(data);
			},
		},
		registerTool(tool: MockTool) {
			registered.push(tool);
		},
	} as unknown as ExtensionAPI;

	installReadmapRenderers(pi);

	const read = makeTool("read");
	const edit = makeTool("edit");
	for (const handler of eventHandlers.get("hashline:tool-executors") ?? []) {
		handler({ read, edit, grep: makeTool("grep") });
	}
	assert.equal(read[READMAP_RENDERER_MARK], true);
	assert.equal(edit[READMAP_RENDERER_MARK], true);

	const bash = makeTool("bash");
	pi.registerTool(bash as never);
	assert.equal(bash[READMAP_RENDERER_MARK], true);
	assert.equal(registered.length, 1);

	// 自己重复安装不叠 wrapper。
	const before = pi.registerTool;
	installReadmapRenderers(pi);
	assert.equal(pi.registerTool, before);

	// 其它扩展后装 wrapper，再 /reload 我们时，二者都仍处于调用链。
	let otherInterceptorCalls = 0;
	pi.registerTool = ((tool: MockTool) => {
		otherInterceptorCalls++;
		before(tool as never);
	}) as unknown as ExtensionAPI["registerTool"];
	installReadmapRenderers(pi);
	const laterBash = makeTool("bash");
	pi.registerTool(laterBash as never);
	assert.equal(otherInterceptorCalls, 1);
	assert.equal(registered.length, 2);
	assert.equal(laterBash[READMAP_RENDERER_MARK], true);
});

test("read renderer respects collapsed summary and expanded hashlines", () => {
	const tool = makeTool("read");
	patchReadmapTool(tool);
	const call = tool.renderCall?.(
		{ path: "src/foo.ts", offset: 20, limit: 5, symbol: "bar" },
		theme,
		{ cwd: "/tmp" },
	) as { render: (w: number) => string[] };
	const callText = stripAnsi(call.render(80).join("\n"));
	assert.match(callText, /read/);
	assert.match(callText, /foo\.ts:20-24/);
	assert.match(callText, /symbol: bar/);

	const result = tool.renderResult?.(
		{
			content: [{ type: "text", text: "20:a1f|const a = 1\n21:b32|const b = 2" }],
			details: {
				ptcValue: {
					range: { startLine: 20, endLine: 21, totalLines: 100 },
					map: true,
					symbol: { name: "bar" },
					warnings: [],
				},
			},
		},
		{ expanded: false },
		theme,
		{ expanded: false },
	) as { render: (w: number) => string[] };
	const collapsed = stripAnsi(result.render(80).join("\n"));
	assert.match(collapsed, /loaded 2 lines/);
	assert.match(collapsed, /map/);
	assert.match(collapsed, /showing 0 of 2 lines · Ctrl\+O to expand/);
	assert.doesNotMatch(collapsed, /const a = 1/);

	const expanded = tool.renderResult?.(
		{
			content: [{ type: "text", text: "20:a1f|const a = 1\n21:b32|const b = 2" }],
			details: {
				ptcValue: {
					range: { startLine: 20, endLine: 21, totalLines: 100 },
					map: true,
				},
			},
		},
		{ expanded: true },
		theme,
		{ expanded: true },
	) as { render: (w: number) => string[] };
	const expandedText = stripAnsi(expanded.render(80).join("\n"));
	assert.match(expandedText, /const a = 1/);
});


test("P0 keeps diff and hashline gutters aligned with visible-width paths", () => {
	const diff = new DiffBodyComponent({
		prefixLines: ["↳ edited +2 -1"],
		diffData: {
			version: 1,
			stats: { added: 1, removed: 1, context: 1 },
			entries: [
				{ kind: "remove", oldLine: 1, text: "old" },
				{ kind: "add", newLine: 20, text: "new" },
				{ kind: "context", oldLine: 99, newLine: 100, text: "same" },
			],
		},
		theme,
		expanded: true,
	});
	const diffLines = diff.render(80).map(stripAnsi).filter((line) => line.includes("│"));
	assert.equal(new Set(diffLines.map((line) => line.indexOf("│"))).size, 1);

	const read = makeTool("read");
	patchReadmapTool(read);
	const readResult = read.renderResult?.(
		{ content: [{ type: "text", text: "1:a|one\n20:bb|two\n100:ccc|three" }] },
		{ expanded: true },
		theme,
		{ expanded: true },
	) as { render: (w: number) => string[] };
	const hashLines = readResult.render(80).map(stripAnsi).filter((line) => /^\s*\d+:/.test(line));
	assert.equal(new Set(hashLines.map((line) => line.indexOf(":"))).size, 1);
	assert.equal(new Set(hashLines.map((line) => line.indexOf("|"))).size, 1);

	const path = `dir/${"组".repeat(25)}.ts`;
	const call = read.renderCall?.({ path }, theme, { cwd: "/tmp" }) as {
		render: (w: number) => string[];
	};
	const callText = stripAnsi(call.render(70).join("\n"));
	assert.ok(!callText.includes(path));
	assert.ok(visibleWidth(callText.split("\n")[0] ?? "") <= 70);
});


test("P1/P2 styles hashline segments, structures stdout, and grids ls", () => {
	const styledColors: string[] = [];
	const styledTheme = {
		fg: (color: string, text: string) => {
			styledColors.push(color);
			return text;
		},
		bold: (text: string) => text,
	};
	const read = makeTool("read");
	patchReadmapTool(read);
	const colored = read.renderResult?.(
		{ content: [{ type: "text", text: "1:abc|const value = 1" }] },
		{ expanded: true },
		styledTheme,
		{ expanded: true },
	) as { render: (w: number) => string[] };
	colored.render(80);
	assert.ok(styledColors.includes("dim"));
	assert.ok(styledColors.includes("accent"));
	assert.ok(styledColors.includes("toolOutput"));

	const colorCalls = styledColors.length;
	const plain = withEnv("PI_READMAP_RENDER_MODE", "plain", () => read.renderResult?.(
		{ content: [{ type: "text", text: "1:abc|plain" }] },
		{ expanded: true },
		styledTheme,
		{ expanded: true },
	)) as { render: (w: number) => string[] };
	plain.render(80);
	assert.equal(styledColors.length, colorCalls);

	const bash = makeTool("bash");
	patchReadmapTool(bash);
	const bashResult = withEnv("PI_READMAP_DIAGNOSTICS", "1", () => bash.renderResult?.(
		{ content: [{ type: "text", text: "\tstdout  \n\u202Ertl" }] },
		{ expanded: true },
		styledTheme,
		{ expanded: true },
	)) as { render: (w: number) => string[] };
	const bashText = bashResult.render(80).join("\n");
	assert.match(bashText, /│/);
	assert.match(bashText, /⇥stdout··/);
	assert.match(bashText, /⟦bidi⟧rtl/);

	const ls = makeTool("ls");
	patchReadmapTool(ls);
	const listed = ls.renderResult?.(
		{
			content: [{ type: "text", text: "" }],
			details: {
				ptcValue: {
					totalEntries: 4,
					entries: [
						{ name: "src", type: "dir" },
						{ name: "one.ts", type: "file" },
						{ name: "二.ts", type: "file" },
						{ name: "four.ts", type: "file" },
					],
				},
			},
		},
		{ expanded: true },
		styledTheme,
		{ expanded: true },
	) as { render: (w: number) => string[] };
	const lsLines = listed.render(100);
	assert.ok(lsLines.some((line) => line.includes("src") && line.includes("二.ts")));
	assertNoOverflow(lsLines.map(stripAnsi), 100);
});

test("P2 uses inline/hunk metadata, split panes, and screen-reader labels", () => {
	const styledColors: string[] = [];
	const styledTheme = {
		fg: (color: string, text: string) => {
			styledColors.push(color);
			return text;
		},
		bold: (text: string) => text,
	};
	const diff = new DiffBodyComponent({
		prefixLines: ["edit: changed"],
		diffData: {
			version: 1,
			language: "typescript",
			stats: { added: 1, removed: 1, context: 0 },
			blockRanges: [{ kind: "remove", startLine: 4, endLine: 4 }],
			inlineDiffs: [{
				removeLineIndex: 0,
				addLineIndex: 1,
				removeSpans: [{ kind: "equal", text: "const " }, { kind: "remove", text: "old" }],
				addSpans: [{ kind: "equal", text: "const " }, { kind: "add", text: "new" }],
			}],
			entries: [
				{ kind: "remove", oldLine: 4, text: "const old" },
				{ kind: "add", newLine: 4, text: "const new" },
			],
		},
		theme: styledTheme,
		expanded: true,
	});
	const unified = diff.render(80).join("\\n");
	assert.match(unified, /hunk 4-4/);
	assert.ok(styledColors.includes("toolDiffRemoved"));
	assert.ok(styledColors.includes("toolDiffAdded"));

	const split = diff.render(120);
	assert.ok(split.some((line) => line.includes(" │ ")));
	assertNoOverflow(split.map(stripAnsi), 120);

	const screenReader = new DiffBodyComponent({
		prefixLines: ["edit: changed"],
		diffData: {
			version: 1,
			stats: { added: 1, removed: 0, context: 0 },
			entries: [{ kind: "add", newLine: 1, text: "new" }],
		},
		theme: styledTheme,
		expanded: true,
		presentation: { mode: "screen-reader", diagnostics: false, theme: undefined },
	});
	const screenText = screenReader.render(80).join("\\n");
	assert.match(screenText, /diff: \+ 1: new/);
	assert.doesNotMatch(screenText, /▌|<success>/);
});


test("P3 pairs indexed split rows, counts ls entries, and handles large diffs", () => {
	const diff = new DiffBodyComponent({
		diffData: {
			version: 1,
			language: "typescript",
			stats: { added: 2, removed: 2, context: 0 },
			blockRanges: [
				{ kind: "remove", startLine: 10, endLine: 11 },
				{ kind: "add", startLine: 20, endLine: 21 },
			],
			inlineDiffs: [
				{
					removeLineIndex: 0,
					addLineIndex: 2,
					removeSpans: [{ kind: "remove", text: "old-A" }],
					addSpans: [{ kind: "add", text: "new-A" }],
				},
				{
					removeLineIndex: 1,
					addLineIndex: 3,
					removeSpans: [{ kind: "remove", text: "old-B" }],
					addSpans: [{ kind: "add", text: "new-B" }],
				},
			],
			entries: [
				{ kind: "remove", oldLine: 10, text: "old-A" },
				{ kind: "remove", oldLine: 11, text: "old-B" },
				{ kind: "add", newLine: 20, text: "new-A" },
				{ kind: "add", newLine: 21, text: "new-B" },
			],
		},
		theme,
		expanded: true,
	});
	const split = diff.render(120).map(stripAnsi);
	assert.ok(split.find((line) => line.includes("old-A"))?.includes("new-A"));
	assert.ok(split.find((line) => line.includes("old-B"))?.includes("new-B"));
	assert.match(split.join("\n"), /- hunk 10-11/);
	assert.match(split.join("\n"), /\+ hunk 20-21/);

	const largeEntries = Array.from({ length: 150_000 }, (_, index) => ({
		kind: "add" as const,
		newLine: index + 1,
		text: "x",
	}));
	assert.doesNotThrow(() => new DiffBodyComponent({
		diffData: {
			stats: { added: largeEntries.length, removed: 0, context: 0 },
			entries: largeEntries,
		},
		expanded: false,
	}).render(80));

	const ls = makeTool("ls");
	patchReadmapTool(ls);
	const listed = ls.renderResult?.(
		{
			content: [{ type: "text", text: "" }],
			details: {
				ptcValue: {
					entries: [
						{ name: "a.ts", type: "file" },
						{ name: "b.ts", type: "file" },
						{ name: "c.ts", type: "file" },
						{ name: "d.ts", type: "file" },
					],
				},
			},
		},
		{ expanded: true },
		theme,
		{ expanded: true },
	) as { render: (width: number) => string[] };
	const listedText = stripAnsi(listed.render(100).join("\n"));
	assert.match(listedText, /4 entries returned/);
	assert.match(listedText, /a\.ts/);
	assert.match(listedText, /d\.ts/);
	assert.doesNotMatch(listedText, /showing 2 of 4 entries/);
});

test("screen-reader mode bypasses Sakura tool framing end to end", () => {
	const read = makeTool("read");
	patchReadmapTool(read);

	type ToolPrototype = {
		render(this: unknown, width: number): string[];
	};
	const prototype = ToolExecutionComponent.prototype as unknown as ToolPrototype;
	const originalRender = prototype.render;
	let renderBody = (_width: number): string[] => ["colored body"];
	prototype.render = function renderForTest(width: number): string[] {
		return renderBody(width);
	};
	const cleanup = installMessageBorders(() => theme as never);

	try {
		const runtime = {
			isPartial: false,
			result: { isError: false, content: [{ type: "text" }] },
			toolName: "read",
			hideComponent: false,
			expanded: true,
			showImages: false,
		};
		const colored = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call(runtime, 80));
		assert.match(stripAnsi(colored.join("\n")), /╭─ ✓ READ · COMPLETE/);

		const plain = withEnv("PI_READMAP_RENDER_MODE", "plain", () => {
			renderBody = () => ["plain body"];
			return prototype.render.call(runtime, 80);
		});
		assert.deepEqual(plain, ["plain body"]);

		const screenReader = withEnv("PI_READMAP_RENDER_MODE", "screen-reader", () => {
			const component = read.renderResult?.(
				{ content: [{ type: "text", text: "1:abc|const value = 1" }] },
				{ expanded: true },
				theme,
				{ expanded: true },
			) as { render: (width: number) => string[] };
			renderBody = (width) => component.render(width);
			return prototype.render.call(runtime, 80);
		});
		const screenText = screenReader.join("\n");
		assert.match(screenText, /read: loaded 1 line/);
		assert.match(screenText, /1:abc\|const value = 1/);
		assert.doesNotMatch(screenText, /[╭╮╰╯┃]|\x1b/);
	} finally {
		cleanup();
		prototype.render = originalRender;
	}
});

test("read error and missing ptcValue fall back safely", () => {
	const tool = makeTool("read");
	patchReadmapTool(tool);

	const err = tool.renderResult?.(
		{ content: [{ type: "text", text: "boom\nstack" }], isError: true },
		{ expanded: false },
		theme,
		{ isError: true },
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(err.render(80).join("\n")), /boom/);
	assert.doesNotMatch(stripAnsi(err.render(80).join("\n")), /stack/);

	const plain = tool.renderResult?.(
		{ content: [{ type: "text", text: "a\nb\nc" }] },
		{ expanded: false },
		theme,
		{},
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(plain.render(80).join("\n")), /loaded 3 lines/);
});

test("edit renderer collapses by default with limited diff preview", () => {
	const tool = makeTool("edit");
	patchReadmapTool(tool);
	const manyEntries = Array.from({ length: 20 }, (_, i) =>
		i % 2 === 0
			? ({ kind: "remove" as const, oldLine: i + 1, text: `old-${i}` })
			: ({ kind: "add" as const, newLine: i + 1, text: `new-${i}` }),
	);
	const diffData = {
		version: 1 as const,
		stats: { added: 10, removed: 10, context: 0 },
		entries: manyEntries,
	};

	const collapsed = tool.renderResult?.(
		{
			content: [{ type: "text", text: "Edited" }],
			details: {
				diffData,
				ptcValue: { ok: true, warnings: ["w"], semanticSummary: { classification: "rename" } },
			},
		},
		{ expanded: false },
		theme,
		{ expanded: false },
	) as { render: (w: number) => string[] };

	const text = stripAnsi(collapsed.render(80).join("\n"));
	assert.match(text, /edited \+10 -10/);
	assert.match(text, /rename|warning/);
	// 折叠态有预览，但不铺满全部 20 行
	assert.match(text, /old-0|new-1/);
	assert.match(text, /showing 8 of 20 diff lines · Ctrl\+O to expand/);
	assert.doesNotMatch(text, /old-18|new-19/);

	const expanded = tool.renderResult?.(
		{
			content: [{ type: "text", text: "Edited" }],
			details: { diffData, ptcValue: { ok: true } },
		},
		{ expanded: true },
		theme,
		{ expanded: true },
	) as { render: (w: number) => string[] };
	const full = stripAnsi(expanded.render(80).join("\n"));
	assert.match(full, /new-19/);
});

test("edit no-op and error paths", () => {
	const tool = makeTool("edit");
	patchReadmapTool(tool);

	const noop = tool.renderResult?.(
		{
			content: [{ type: "text", text: "nothing changed" }],
			details: { ptcValue: { ok: true, noopEdits: [{}] } },
		},
		{ expanded: false },
		theme,
		{},
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(noop.render(80).join("\n")), /no-op/);

	const failed = tool.renderResult?.(
		{
			content: [{ type: "text", text: "anchor mismatch\nmore" }],
			isError: true,
		},
		{ expanded: false },
		theme,
		{ isError: true },
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(failed.render(80).join("\n")), /anchor mismatch/);
});

test("write created stays summary when collapsed; expanded caps content lines", () => {
	const tool = makeTool("write");
	patchReadmapTool(tool);
	const manyLines = Array.from({ length: 40 }, (_, i) => ({
		raw: i === 1 ? "" : `${i + 1}:aaa|line-${i}`,
	}));

	const collapsed = tool.renderResult?.(
		{
			content: [{ type: "text", text: "ok" }],
			details: {
				writeState: "created",
				ptcValue: { ok: true, lines: manyLines },
			},
		},
		{ expanded: false },
		theme,
		{ expanded: false },
	) as { render: (w: number) => string[] };
	const collapsedText = stripAnsi(collapsed.render(80).join("\n"));
	assert.match(collapsedText, /created/);
	assert.match(collapsedText, /40 lines/);
	assert.doesNotMatch(collapsedText, /line-0/);

	const created = tool.renderResult?.(
		{
			content: [{ type: "text", text: "ok" }],
			details: {
				writeState: "created",
				ptcValue: { ok: true, lines: manyLines },
			},
		},
		{ expanded: true },
		theme,
		{ expanded: true },
	) as { render: (w: number) => string[] };
	const createdText = stripAnsi(created.render(80).join("\n"));
	assert.match(createdText, /created/);
	assert.match(createdText, /line-0/);
	assert.match(createdText, /showing 12 of 40 lines/);
	assert.doesNotMatch(createdText, /line-39/);
	// 空行也占预览配额，不能因为 filter(Boolean) 让第 13 行漏进来。
	assert.doesNotMatch(createdText, /line-12/);
	assert.doesNotMatch(createdText, /▌\+/);

	const overwritten = tool.renderResult?.(
		{
			content: [{ type: "text", text: "ok" }],
			details: {
				writeState: "overwritten",
				diffData: {
					version: 1,
					stats: { added: 1, removed: 1, context: 0 },
					entries: [
						{ kind: "remove", oldLine: 1, text: "a" },
						{ kind: "add", newLine: 1, text: "b" },
					],
				},
			},
		},
		{ expanded: false },
		theme,
		{ expanded: false },
	) as { render: (w: number) => string[] };
	const overText = stripAnsi(overwritten.render(100).join("\n"));
	assert.match(overText, /overwritten/);
	assert.doesNotMatch(overText, /↳ diff/);
	// 折叠态也有少量 diff 预览
	assert.match(overText, /▌/);
});

test("bash short output shows body when collapsed; long output previews", () => {
	const tool = makeTool("bash");
	patchReadmapTool(tool);

	const short = tool.renderResult?.(
		{ content: [{ type: "text", text: "ok\npass" }] },
		{ expanded: false },
		theme,
		{ expanded: false },
	) as { render: (w: number) => string[] };
	const shortText = stripAnsi(short.render(80).join("\n"));
	assert.match(shortText, /2 lines returned/);
	assert.match(shortText, /pass/);

	const longBody = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
	const long = tool.renderResult?.(
		{ content: [{ type: "text", text: longBody }] },
		{ expanded: false },
		theme,
		{ expanded: false },
	) as { render: (w: number) => string[] };
	const longText = stripAnsi(long.render(80).join("\n"));
	assert.match(longText, /40 lines returned/);
	assert.match(longText, /line-0/); // 先显示一段
	assert.match(longText, /showing 12 of 40 lines · Ctrl\+O to expand/);
	assert.doesNotMatch(longText, /line-39/);

	const empty = tool.renderResult?.(
		{ content: [{ type: "text", text: "" }] },
		{ expanded: false },
		theme,
		{},
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(empty.render(80).join("\n")), /no output/);

	const failed = tool.renderResult?.(
		{ content: [{ type: "text", text: "fail-first\nrest" }], isError: true },
		{ expanded: false },
		theme,
		{ isError: true },
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(failed.render(80).join("\n")), /fail-first/);
	assert.doesNotMatch(stripAnsi(failed.render(80).join("\n")), /\nrest/);
});


test("readmap removes terminal control sequences from tool inputs and outputs", () => {
	const malicious = "\x1b]52;c;YQ==\x07visible\x1b[2J";
	const bash = makeTool("bash");
	patchReadmapTool(bash);
	const bashResult = bash.renderResult?.(
		{ content: [{ type: "text", text: malicious }] },
		{ expanded: false },
		theme,
		{ expanded: false },
	) as { render: (w: number) => string[] };
	const bashText = bashResult.render(80).join("\n");
	assert.doesNotMatch(bashText, /\x1b/);
	assert.match(bashText, /visible/);

	const read = makeTool("read");
	patchReadmapTool(read);
	const readCall = read.renderCall?.(
		{ path: `src/${malicious}.ts` },
		theme,
		{ cwd: "/tmp" },
	) as { render: (w: number) => string[] };
	assert.doesNotMatch(readCall.render(80).join("\n"), /\x1b/);

	const edit = makeTool("edit");
	patchReadmapTool(edit);
	const editResult = edit.renderResult?.(
		{
			content: [{ type: "text", text: "Edited" }],
			details: {
				diffData: {
					version: 1,
					stats: { added: 1, removed: 0, context: 0 },
					entries: [{ kind: "add", newLine: 1, text: malicious }],
				},
			},
		},
		{ expanded: true },
		theme,
		{ expanded: true },
	) as { render: (w: number) => string[] };
	const editText = editResult.render(80).join("\n");
	assert.doesNotMatch(editText, /\x1b/);
	assert.match(editText, /visible/);
});


test("ls renderer shows path, typed entries, truncation, empty and error states", () => {
	const tool = makeTool("ls");
	patchReadmapTool(tool);

	const call = tool.renderCall?.(
		{ path: "src", glob: "*.ts", limit: "5" },
		theme,
		{ cwd: "/tmp" },
	) as { render: (w: number) => string[] };
	const callText = stripAnsi(call.render(80).join("\n"));
	assert.match(callText, /ls/);
	assert.match(callText, /src/);
	assert.match(callText, /glob: \*\.ts/);
	assert.match(callText, /limit: 5/);

	const entries = Array.from({ length: 20 }, (_, i) => ({
		name: i === 0 ? "src" : `file-${i}.ts`,
		type: i === 0 ? "dir" : "file",
	}));
	const collapsed = tool.renderResult?.(
		{
			content: [{ type: "text", text: entries.map((entry) => entry.type === "dir" ? `${entry.name}/` : entry.name).join("\n") }],
			details: { ptcValue: { totalEntries: 20, truncated: true, entries } },
		},
		{ expanded: false },
		theme,
		{ expanded: false },
	) as { render: (w: number) => string[] };
	const collapsedText = stripAnsi(collapsed.render(80).join("\n"));
	assert.match(collapsedText, /20 entries returned/);
	assert.match(collapsedText, /▸ src\//);
	assert.match(collapsedText, /file-1\.ts/);
	assert.match(collapsedText, /Ctrl\+O to expand/);
	assert.doesNotMatch(collapsedText, /file-19\.ts/);

	const expanded = tool.renderResult?.(
		{
			content: [{ type: "text", text: "" }],
			details: { ptcValue: { totalEntries: 20, truncated: true, entries } },
		},
		{ expanded: true },
		theme,
		{ expanded: true },
	) as { render: (w: number) => string[] };
	const expandedText = stripAnsi(expanded.render(80).join("\n"));
	assert.match(expandedText, /file-19\.ts/);
	assert.doesNotMatch(expandedText, /Ctrl\+O to expand/);

	const empty = tool.renderResult?.(
		{ content: [{ type: "text", text: "(empty directory)" }], details: { ptcValue: { totalEntries: 0, entries: [] } } },
		{ expanded: false },
		theme,
		{},
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(empty.render(80).join("\n")), /empty directory/);

	const failed = tool.renderResult?.(
		{ content: [{ type: "text", text: "permission denied\nextra detail" }], isError: true },
		{ expanded: false },
		theme,
		{ isError: true },
	) as { render: (w: number) => string[] };
	const failedText = stripAnsi(failed.render(80).join("\n"));
	assert.match(failedText, /permission denied/);
	assert.doesNotMatch(failedText, /extra detail/);

	const wideName = tool.renderResult?.(
		{
			content: [{ type: "text", text: "" }],
			details: { ptcValue: { totalEntries: 1, entries: [{ name: "x".repeat(200), type: "file" }] } },
		},
		{ expanded: true },
		theme,
		{ expanded: true },
	) as { render: (w: number) => string[] };
	assertNoOverflow(wideName.render(40), 40);
});

test("DiffBodyComponent and tool renders stay within 40/80/100/120 columns", () => {
	const diff = new DiffBodyComponent({
		prefixLines: ["↳ edited +1 -1"],
		diffData: {
			stats: { added: 1, removed: 1 },
			entries: [
				{ kind: "remove", oldLine: 1, text: "x".repeat(200) },
				{ kind: "add", newLine: 1, text: "y".repeat(200) },
			],
		},
		theme,
		expanded: true,
	});

	for (const width of [40, 80, 100, 120]) {
		assertNoOverflow(diff.render(width), width);
	}

	const tool = makeTool("read");
	patchReadmapTool(tool);
	const component = tool.renderResult?.(
		{
			content: [
				{
					type: "text",
					text: `1:abc|${"z".repeat(300)}\n2:def|tail`,
				},
			],
			details: {
				ptcValue: {
					range: { startLine: 1, endLine: 2, totalLines: 2 },
				},
			},
		},
		{ expanded: true },
		theme,
		{ expanded: true },
	) as { render: (w: number) => string[] };

	for (const width of [40, 80, 100, 120]) {
		assertNoOverflow(component.render(width), width);
	}
});

test("theme fg throw falls back to plain text", () => {
	const tool = makeTool("bash");
	patchReadmapTool(tool);
	const badTheme = {
		fg() {
			throw new Error("no theme");
		},
		bold() {
			throw new Error("no bold");
		},
	};
	const component = tool.renderCall?.(
		{ command: "echo hi" },
		badTheme,
		{},
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(component.render(40).join("\n")), /echo hi/);
});


test("clampLine never exceeds width", () => {
	const line = clampLine("hello world ".repeat(20), 40);
	assert.ok(visibleWidth(line) <= 40);
});
