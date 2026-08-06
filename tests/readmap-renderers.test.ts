import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import installReadmapRenderers, {
	DiffBodyComponent,
	READMAP_RENDERER_MARK,
	clampLine,
	patchReadmapTool,
	patchToolPayload,
} from "../src/readmap-renderers.ts";

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
		{ cwd: "/tmp", width: 80 },
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
		{ expanded: false, width: 80 },
	) as { render: (w: number) => string[] };
	const collapsed = stripAnsi(result.render(80).join("\n"));
	assert.match(collapsed, /loaded 2 lines/);
	assert.match(collapsed, /map/);
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
		{ expanded: true, width: 80 },
	) as { render: (w: number) => string[] };
	const expandedText = stripAnsi(expanded.render(80).join("\n"));
	assert.match(expandedText, /const a = 1/);
});

test("read error and missing ptcValue fall back safely", () => {
	const tool = makeTool("read");
	patchReadmapTool(tool);

	const err = tool.renderResult?.(
		{ content: [{ type: "text", text: "boom\nstack" }], isError: true },
		{ expanded: false },
		theme,
		{ isError: true, width: 80 },
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(err.render(80).join("\n")), /boom/);
	assert.doesNotMatch(stripAnsi(err.render(80).join("\n")), /stack/);

	const plain = tool.renderResult?.(
		{ content: [{ type: "text", text: "a\nb\nc" }] },
		{ expanded: false },
		theme,
		{ width: 80 },
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
		{ expanded: false, width: 80 },
	) as { render: (w: number) => string[] };

	const text = stripAnsi(collapsed.render(80).join("\n"));
	assert.match(text, /edited \+10 -10/);
	assert.match(text, /rename|warning/);
	// 折叠态有预览，但不铺满全部 20 行
	assert.match(text, /old-0|new-1/);
	assert.match(text, /more diff/);
	assert.doesNotMatch(text, /old-18|new-19/);

	const expanded = tool.renderResult?.(
		{
			content: [{ type: "text", text: "Edited" }],
			details: { diffData, ptcValue: { ok: true } },
		},
		{ expanded: true },
		theme,
		{ expanded: true, width: 80 },
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
		{ width: 80 },
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(noop.render(80).join("\n")), /no-op/);

	const failed = tool.renderResult?.(
		{
			content: [{ type: "text", text: "anchor mismatch\nmore" }],
			isError: true,
		},
		{ expanded: false },
		theme,
		{ isError: true, width: 80 },
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
		{ expanded: false, width: 80 },
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
		{ expanded: true, width: 80 },
	) as { render: (w: number) => string[] };
	const createdText = stripAnsi(created.render(80).join("\n"));
	assert.match(createdText, /created/);
	assert.match(createdText, /line-0/);
	assert.match(createdText, /more lines/);
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
		{ expanded: false, width: 100 },
	) as { render: (w: number) => string[] };
	const overText = stripAnsi(overwritten.render(100).join("\n"));
	assert.match(overText, /overwritten/);
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
		{ expanded: false, width: 80 },
	) as { render: (w: number) => string[] };
	const shortText = stripAnsi(short.render(80).join("\n"));
	assert.match(shortText, /2 lines returned/);
	assert.match(shortText, /pass/);

	const longBody = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
	const long = tool.renderResult?.(
		{ content: [{ type: "text", text: longBody }] },
		{ expanded: false },
		theme,
		{ expanded: false, width: 80 },
	) as { render: (w: number) => string[] };
	const longText = stripAnsi(long.render(80).join("\n"));
	assert.match(longText, /40 lines returned/);
	assert.match(longText, /line-0/); // 先显示一段
	assert.match(longText, /more lines/);
	assert.doesNotMatch(longText, /line-39/);

	const empty = tool.renderResult?.(
		{ content: [{ type: "text", text: "" }] },
		{ expanded: false },
		theme,
		{ width: 80 },
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(empty.render(80).join("\n")), /no output/);

	const failed = tool.renderResult?.(
		{ content: [{ type: "text", text: "fail-first\nrest" }], isError: true },
		{ expanded: false },
		theme,
		{ isError: true, width: 80 },
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(failed.render(80).join("\n")), /fail-first/);
	assert.doesNotMatch(stripAnsi(failed.render(80).join("\n")), /\nrest/);
});


test("ls renderer shows path, typed entries, truncation, empty and error states", () => {
	const tool = makeTool("ls");
	patchReadmapTool(tool);

	const call = tool.renderCall?.(
		{ path: "src", glob: "*.ts", limit: "5" },
		theme,
		{ cwd: "/tmp", width: 80 },
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
		{ expanded: false, width: 80 },
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
		{ expanded: true, width: 80 },
	) as { render: (w: number) => string[] };
	const expandedText = stripAnsi(expanded.render(80).join("\n"));
	assert.match(expandedText, /file-19\.ts/);
	assert.doesNotMatch(expandedText, /Ctrl\+O to expand/);

	const empty = tool.renderResult?.(
		{ content: [{ type: "text", text: "(empty directory)" }], details: { ptcValue: { totalEntries: 0, entries: [] } } },
		{ expanded: false },
		theme,
		{ width: 80 },
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(empty.render(80).join("\n")), /empty directory/);

	const failed = tool.renderResult?.(
		{ content: [{ type: "text", text: "permission denied\nextra detail" }], isError: true },
		{ expanded: false },
		theme,
		{ isError: true, width: 80 },
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
		{ expanded: true, width: 40 },
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
		{ width: 40 },
	) as { render: (w: number) => string[] };
	assert.match(stripAnsi(component.render(40).join("\n")), /echo hi/);
});


test("clampLine never exceeds width", () => {
	const line = clampLine("hello world ".repeat(20), 40);
	assert.ok(visibleWidth(line) <= 40);
});
