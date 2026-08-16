import assert from "node:assert/strict";
import test from "node:test";
import { BashExecutionComponent, ToolExecutionComponent, UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import installReadmapRenderers, {
	DiffBodyComponent,
	advanceStreamReveal,
	READMAP_RENDERER_MARK,
	clampLine,
	patchReadmapTool,
	patchToolPayload,
} from "../src/readmap-renderers/index.ts";
import { installMessageBorders } from "../src/message-borders.ts";
import { resolveRenderMode } from "../src/render-mode.ts";

// 测试基线固定为 color 模式：宿主终端的 NO_COLOR/TERM 不得改变断言结果。
// 显式 plain / screen-reader 用例仍通过 withEnv 覆盖 PI_READMAP_RENDER_MODE。
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

test("render mode falls back to plain when NO_COLOR is set", () => {
	withEnv("PI_READMAP_RENDER_MODE", undefined, () => {
		withEnv("NO_COLOR", "1", () => {
			assert.equal(resolveRenderMode(), "plain", "NO_COLOR should force plain mode");
		});
		withEnv("NO_COLOR", undefined, () => {
			assert.equal(resolveRenderMode(), "color", "default mode should be color");
		});
	});
	withEnv("PI_READMAP_RENDER_MODE", "screen-reader", () => {
		withEnv("NO_COLOR", "1", () => {
			assert.equal(
				resolveRenderMode(),
				"screen-reader",
				"explicit PI_READMAP_RENDER_MODE should win over NO_COLOR",
			);
		});
	});
});

test("patchToolPayload ignores bad payload and skips non-target tools", () => {
	assert.deepEqual(patchToolPayload(undefined), []);
	assert.deepEqual(patchToolPayload(null), []);
	assert.deepEqual(patchToolPayload("x"), []);
	assert.deepEqual(patchToolPayload({ todo: makeTool("todo") }), []);
	// grep/find 已进目标集合：payload 路径同样可达（核心桥接之外的冗余覆盖）。
	assert.deepEqual(patchToolPayload({ grep: makeTool("grep") }), ["grep"]);
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
	assert.equal(tool.renderShell, "self");
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

test("read renderer keeps the collapsed summary and shows the completed line range", () => {
	const tool = makeTool("read");
	patchReadmapTool(tool);
	const call = tool.renderCall?.(
		{ path: "src/foo.ts", offset: "20", limit: "5", symbol: "bar" },
		theme,
		{ cwd: "/tmp" },
	) as { render: (w: number) => string[] };
	const callText = stripAnsi(call.render(80).join("\n"));
	assert.match(callText, /Read/);
	assert.match(callText, /foo\.ts:20 ~ 24/);
	assert.match(callText, /symbol: bar/);

	const result = tool.renderResult?.(
		{
			content: [{ type: "text", text: "20:a1f|const a = 1\n21:b32|const b = 2" }],
			details: {
				ptcValue: {
					range: { startLine: 20, endLine: 21, totalLines: 100 },
					map: { requested: false, appended: false },
					symbol: { name: "bar" },
					warnings: [],
				},
			},
		},
		{ expanded: false },
		theme,
		{
			expanded: false,
			args: { path: "src/foo.ts", offset: "20", limit: "5", symbol: "bar" },
		},
	) as { render: (w: number) => string[] };
	const collapsed = stripAnsi(result.render(80).join("\n"));
	assert.match(collapsed, /✓ Read.*foo\.ts.*20 ~ 21.*2 lines.*map.*Ctrl\+O/);
	assert.doesNotMatch(collapsed, /showing 0 of/);
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

test("read renderer colors the completed line range as syntaxNumber", () => {
	const tool = makeTool("read");
	patchReadmapTool(tool);
	const colors: Array<{ color: string; text: string }> = [];
	const rangeTheme = {
		fg: (color: string, text: string) => {
			colors.push({ color, text });
			return text;
		},
		bold: (text: string) => text,
	};
	const result = tool.renderResult?.(
		{
			content: [{ type: "text", text: "31:a31|line 31\n32:a32|line 32" }],
			details: {
				ptcValue: {
					range: { startLine: 31, endLine: 32, totalLines: 100 },
					map: { requested: false, appended: false },
					warnings: [],
				},
			},
		},
		{ expanded: false },
		rangeTheme,
		{ expanded: false, args: { path: "src/foo.ts", offset: "31", limit: "2" } },
	) as { render: (w: number) => string[] };
	result.render(80);
	assert.ok(
		colors.some((part) => part.color === "syntaxNumber" && part.text === "31 ~ 32"),
		"completed read range should use syntaxNumber color",
	);
});

test("read renderer rejects malformed and unsafe line ranges", () => {
	const tool = makeTool("read");
	patchReadmapTool(tool);
	for (const args of [
		{ path: "foo.ts", offset: "abc", limit: "2" },
		{ path: "foo.ts", offset: "-5", limit: "2" },
		{ path: "foo.ts", offset: 0, limit: 2 },
		{ path: "foo.ts", offset: Number.MAX_SAFE_INTEGER + 1, limit: 1 },
	]) {
		const call = tool.renderCall?.(args, theme, { cwd: "/tmp" }) as { render: (w: number) => string[] };
		const rendered = stripAnsi(call.render(80).join("\n"));
		assert.doesNotMatch(rendered, /foo\.ts:\d+ ~ \d+/);
	}
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
	assert.ok(!callText.includes(path), "long CJK path should be shortened in the call line");
	assert.ok(visibleWidth(callText.split("\n")[0] ?? "") <= 70, "call line must fit the 70-column width");

	const rangeColors: Array<{ color: string; text: string }> = [];
	const rangeTheme = {
		fg: (color: string, text: string) => {
			rangeColors.push({ color, text });
			return text;
		},
		bold: (text: string) => text,
	};
	const rangedCall = read.renderCall?.(
		{ path: "src/message-borders.ts", offset: 410, limit: 155 },
		rangeTheme,
		{ cwd: "/tmp" },
	) as { render(width: number): string[] };
	rangedCall.render(80);
	assert.ok(
		rangeColors.some((part) => part.color === "syntaxType" && part.text === "src/message-borders.ts"),
		"read path should use syntaxType color",
	);
	assert.ok(
		rangeColors.some((part) => part.color === "syntaxNumber" && part.text === ":410 ~ 564"),
		"read range suffix should use syntaxNumber color",
	);
	assert.ok(
		!rangeColors.some((part) => part.color === "syntaxType" && part.text.includes(":410 ~ 564")),
		"range suffix must not be colored as part of the path",
	);

	for (const name of ["edit", "write", "ls"]) {
		rangeColors.length = 0;
		const pathTool = makeTool(name);
		patchReadmapTool(pathTool);
		const pathCall = pathTool.renderCall?.(
			{ path: `src/${name}.ts` },
			rangeTheme,
			{ cwd: "/tmp" },
		) as { render(width: number): string[] };
		pathCall.render(80);
		assert.ok(
			rangeColors.some((part) => part.color === "syntaxType" && part.text === `src/${name}.ts`),
			`${name} 路径必须使用 syntaxType`,
		);
	}
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
	assert.ok(styledColors.includes("dim"), "hashline gutter should use dim color");
	assert.ok(styledColors.includes("success"), "success marker should use success color");
	assert.ok(styledColors.includes("toolOutput"), "hashline content should use toolOutput color");

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
	assert.ok(
		lsLines.some((line) => line.includes("src") && line.includes("二.ts")),
		"wide ls should grid two entries on one row",
	);
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
	assert.ok(styledColors.includes("toolDiffRemoved"), "removed spans should use toolDiffRemoved");
	assert.ok(styledColors.includes("toolDiffAdded"), "added spans should use toolDiffAdded");

	const split = diff.render(120);
	assert.ok(split.some((line) => line.includes(" │ ")), "wide diff should render split panes");
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
	assert.ok(
		split.find((line) => line.includes("old-A"))?.includes("new-A"),
		"indexed pair A should share one split row",
	);
	assert.ok(
		split.find((line) => line.includes("old-B"))?.includes("new-B"),
		"indexed pair B should share one split row",
	);
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
	assert.match(listedText, /4 entries/);
	assert.match(listedText, /a\.ts/);
	assert.match(listedText, /d\.ts/);
	assert.doesNotMatch(listedText, /showing 2 of 4 entries/);

	const defaultLsColor = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
		(ls.renderCall?.({}, theme, { isPartial: true, cwd: "/tmp" }) as { render(width: number): string[] }).render(80));
	assert.match(stripAnsi(defaultLsColor[0] ?? ""), /^◇ Ls  \./);
	assert.doesNotMatch(stripAnsi(defaultLsColor[0] ?? ""), /…/);
	const defaultLsPlain = withEnv("PI_READMAP_RENDER_MODE", "plain", () =>
		(ls.renderCall?.({}, theme, { isPartial: true, cwd: "/tmp" }) as { render(width: number): string[] }).render(80));
	assert.match(stripAnsi(defaultLsPlain[0] ?? ""), /^Ls  \./);
	assert.doesNotMatch(stripAnsi(defaultLsPlain[0] ?? ""), /^\s/);
});

test("read stays borderless while framed tools embed titles without native backgrounds", () => {
	const read = makeTool("read");
	patchReadmapTool(read);

	type ToolPrototype = {
		render(this: unknown, width: number): string[];
	};
	const prototype = ToolExecutionComponent.prototype as unknown as ToolPrototype;
	const originalRender = prototype.render;
	let predecessorWidth = 0;
	let renderBody = (_width: number): string[] => ["colored body"];
	prototype.render = function renderForTest(width: number): string[] {
		predecessorWidth = width;
		return renderBody(width);
	};
	const cleanup = installMessageBorders(() => theme as never);

	try {
		const readRuntime = {
			isPartial: false,
			result: { isError: false, content: [{ type: "text" }] },
			toolName: "read",
			hideComponent: false,
			expanded: true,
			showImages: false,
		};
		const coloredRead = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call(readRuntime, 80));
		assert.deepEqual(stripAnsi(coloredRead.join("\n")), "  ✓ colored body");
		assert.doesNotMatch(stripAnsi(coloredRead.join("\n")), /[╭╮╰╯]/);
		assert.ok(
			coloredRead.every((line) => line.length === 0 || stripAnsi(line).startsWith("  ")),
			"read lines should keep the two-column indent",
		);
		assert.equal(predecessorWidth, 78, "Read 的 2 列缩进必须先从正文宽度预算中扣除");

		const terminalImage = "\x1b_Gf=100;AAAA\x1b\\";
		renderBody = () => ["✓ Read  image.png · 1 line", terminalImage];
		const imageRead = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call({
				...readRuntime,
				result: { isError: false, content: [{ type: "image" }] },
			}, 80));
		assert.match(stripAnsi(imageRead[0] ?? ""), /^  ✓ Read/);
		assert.equal(imageRead[1], terminalImage, "图片控制序列必须原样保留");
		assert.equal(predecessorWidth, 78, "图片 Read 同样必须预留 2 列摘要缩进");

		for (const toolName of ["edit", "write", "bash", "ls", "grep", "todo"]) {
			const label = toolName[0]!.toUpperCase() + toolName.slice(1);
			renderBody = () => [
				`✓ ${label}  target`,
				"\x1b[48;2;80;80;80m\x1b[38;2;1;2;3mbody\x1b[39m\x1b[49m",
			];
			const framed = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
				prototype.render.call({ ...readRuntime, toolName }, 80));
			const framedText = stripAnsi(framed.join("\n"));
			assert.match(framedText, new RegExp(`^╭─ ✓ ${label}  target ─+╮`));
			assert.match(framedText, /\n┃\s+│\n┃body\s+│\n╰─+╯$/);
			assert.equal(framedText.match(new RegExp(label, "g"))?.length, 1);
			assert.doesNotMatch(framed.join("\n"), /\x1b\[(?:48[;:]|49m)/);
			assert.match(framed.join("\n"), /\x1b\[38;2;1;2;3m/);
			assertNoOverflow(framed, 80);
			assert.equal(predecessorWidth, 78, `${toolName} 外框的 2 列 chrome 必须先从正文宽度预算中扣除`);
		}

		const splitRightText = "在已完成的视觉研究基础上，连续实施 Sakura Quiet 的 P0、P1、P2 改造；保持 Thinking 完全不动，并完成全量验证与工作记录。";
		const splitDiff = new DiffBodyComponent({
			diffData: {
				stats: { added: 1, removed: 1 },
				entries: [
					{ kind: "remove", oldLine: 4, text: "old" },
					{ kind: "add", newLine: 4, text: splitRightText },
				],
				inlineDiffs: [{
					removeLineIndex: 0,
					addLineIndex: 1,
					removeSpans: [{ kind: "remove", text: "old" }],
					addSpans: [{ kind: "add", text: splitRightText }],
				}],
			},
			theme,
			expanded: true,
		});
		renderBody = (width) => ["✓ Edit  plan.md", ...splitDiff.render(width)];
		const splitFrame = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call({ ...readRuntime, toolName: "edit" }, 181));
		const splitPaneWidth = Math.floor((predecessorWidth - 3) / 2);
		const reconstructedRight = splitFrame
			.map(stripAnsi)
			.filter((line) => line.startsWith("┃"))
			.map((line) => line.slice(1, -1))
			.map((line) => line.slice(splitPaneWidth + 3))
			.map((line) => line.replace(/^▌\+\s+\d+\s+│\s*/, "").trim())
			.join("")
			.replace(/\s+/g, "");
		assert.equal(predecessorWidth, 179);
		assert.equal(reconstructedRight, splitRightText.replace(/\s+/g, ""));
		assertNoOverflow(splitFrame, 181);


		const fittingBashCommand = `echo "箱宝在线~ $(date '+%Y-%m-%d %H:%M:%S')"; uptime`;
		renderBody = () => [
			`\x1b[38;2;1;2;3m✓ bash ${fittingBashCommand}${" ".repeat(160)}\x1b[39m`,
			"↳ 2 lines returned",
			"箱宝在线~ 2026-08-10 02:32:24",
		];
		const fittingBash = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call({ ...readRuntime, toolName: "bash" }, 190));
		const fittingBashTop = stripAnsi(fittingBash[0] ?? "");
		assert.match(fittingBashTop, /uptime ─+╮$/);
		assert.doesNotMatch(fittingBashTop, /…/);
		assertNoOverflow(fittingBash, 190);

		const longTitle = `\x1b[38;2;1;2;3m✓ Todo  ${"超长标题".repeat(80)}\x1b[39m`;
		for (const width of [8, 10, 20, 40, 80, 160]) {
			renderBody = () => [longTitle, "正文".repeat(200)];
			const framed = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
				prototype.render.call({ ...readRuntime, toolName: "todo" }, width));
			const top = stripAnsi(framed[0] ?? "");
			assert.ok(framed.every((line) => visibleWidth(line) === width), `frame must fill width ${width}`);
			assert.match(top, /^╭─ /);
			assert.match(top, /… ─+╮$/);
		}

		const originalNow = Date.now;
		try {
			// 运行中卡片除标题 spinner 外必须逐字节稳定，避免扩大 pi-tui 的差量重绘区间。
			renderBody = () => ["◇ Edit  target"];
			Date.now = () => 0;
			const firstFrame = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
				prototype.render.call({ ...readRuntime, isPartial: true, result: undefined, toolName: "edit" }, 80));
			Date.now = () => 80;
			const secondFrame = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
				prototype.render.call({ ...readRuntime, isPartial: true, result: undefined, toolName: "edit" }, 80));
			assert.match(stripAnsi(firstFrame.join("\n")), /^╭─ ⠋ Edit/);
			assert.match(stripAnsi(secondFrame.join("\n")), /^╭─ ⠙ Edit/);
			assert.deepEqual(firstFrame.slice(1), secondFrame.slice(1), "标题 spinner 之外的行必须逐字节稳定");

			renderBody = () => ["◇ Read  target"];
			const runningRead = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
				prototype.render.call({ ...readRuntime, isPartial: true, result: undefined }, 80));
			assert.match(stripAnsi(runningRead.join("\n")), /^  ⠙ Read/);
			assert.doesNotMatch(stripAnsi(runningRead.join("\n")), /◇/);
		} finally {
			Date.now = originalNow;
		}

		const plain = withEnv("PI_READMAP_RENDER_MODE", "plain", () => {
			renderBody = () => ["plain body"];
			return prototype.render.call({ ...readRuntime, toolName: "edit" }, 80);
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
			return prototype.render.call(readRuntime, 80);
		});
		const screenText = screenReader.join("\n");
		assert.match(screenText, /read complete:.*1 line/);
		assert.match(screenText, /1:abc\|const value = 1/);
		assert.doesNotMatch(screenText, /[╭╮╰╯┃]|\x1b/);
	} finally {
		cleanup();
		prototype.render = originalRender;
	}
});
// 工具卡状态底色固定为马卡龙 rail 色相压进墨底（mix(ink, rail, 0.24)），不再取宿主主题的 tool*Bg。
const TOOL_BG_RUNNING_ANSI = "\x1b[48;2;59;70;88m";
const TOOL_BG_SUCCESS_ANSI = "\x1b[48;2;62;75;78m";
const TOOL_BG_ERROR_ANSI = "\x1b[48;2;82;54;70m";
const TOOL_BG_CANCELLED_ANSI = "\x1b[48;2;79;72;64m";

test("tool status background is optional, Sakura-fixed, and semantic", () => {
	type ToolPrototype = { render(this: unknown, width: number): string[] };
	const prototype = ToolExecutionComponent.prototype as unknown as ToolPrototype;
	const originalRender = prototype.render;
	let renderBody = (_width: number): string[] => ["✓ Edit  target", "body"];
	const backgroundCalls: string[] = [];
	const makeBackgroundTheme = (code: number) => ({
		...theme,
		bg: (color: string, text: string) => {
			backgroundCalls.push(color);
			return `\x1b[48;5;${code}m${text}\x1b[49m`;
		},
	});
	const backgroundTheme = makeBackgroundTheme(240);
	const alternateTheme = makeBackgroundTheme(241);
	let currentTheme = backgroundTheme;
	const settings = { toolBackground: false };
	prototype.render = function renderForBackground(width: number): string[] {
		return renderBody(width);
	};
	const cleanup = installMessageBorders(() => currentTheme as never, settings);

	try {
		const runtime = {
			isPartial: false,
			result: { isError: false, content: [{ type: "text" }] },
			toolName: "edit",
			hideComponent: false,
			expanded: false,
			showImages: false,
		};
		const withoutBackground = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call(runtime, 80));
		assert.doesNotMatch(withoutBackground.join("\n"), /\x1b\[48[;:]/);

		settings.toolBackground = true;
		const withBackground = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call(runtime, 80));
		assert.ok(
			withBackground.slice(1, -1).every((line) => line.includes(TOOL_BG_SUCCESS_ANSI)),
			"every inner line should carry the fixed success background",
		);
		assert.equal(withBackground.length, 5);
		assert.ok(withBackground.every((line) => visibleWidth(line) === 80), "background frame must stay exactly within the requested width");
		for (const line of withBackground.slice(1, -1)) {
			const backgroundStart = line.indexOf(TOOL_BG_SUCCESS_ANSI);
			const backgroundEnd = line.indexOf("\x1b[49m", backgroundStart);
			assert.ok(backgroundStart >= 0 && backgroundEnd >= 0, "background must open and close on the line");
			assert.equal(visibleWidth(line.slice(0, backgroundStart)), 1, "background must start after the left rail");
			assert.equal(visibleWidth(line.slice(backgroundEnd + "\x1b[49m".length)), 1, "background must end before the right rail");
		}
		assert.match(stripAnsi(withBackground.at(-2) ?? ""), /^┃\s+│$/, "framed tools keep a padded row above the bottom border");
		assert.doesNotMatch(withBackground[0] ?? "", /\x1b\[48[;:]/);
		assert.doesNotMatch(withBackground.at(-1) ?? "", /\x1b\[48[;:]/);
		assert.deepEqual(backgroundCalls, [], "fixed palette must not consult theme.bg");

		currentTheme = alternateTheme;
		const withAlternateTheme = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call(runtime, 80));
		assert.ok(withAlternateTheme.join("\n").includes(TOOL_BG_SUCCESS_ANSI), "fixed palette must persist across theme switches");
		assert.doesNotMatch(withAlternateTheme.join("\n"), /\x1b\[48;5;/);
		currentTheme = backgroundTheme;

		settings.toolBackground = false;
		const afterToggleOff = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call(runtime, 80));
		assert.doesNotMatch(afterToggleOff.join("\n"), /\x1b\[48[;:]/);

		const plain = withEnv("PI_READMAP_RENDER_MODE", "plain", () =>
			prototype.render.call(runtime, 80));
		assert.deepEqual(plain, ["✓ Edit  target", "body"]);

		settings.toolBackground = true;
		renderBody = () => ["✓ Read  target", "body"];
		const read = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call({ ...runtime, toolName: "read" }, 80));
		assert.doesNotMatch(read.join("\n"), /\x1b\[48[;:]/);

		renderBody = () => ["◇ Edit  target", "body"];
		const running = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call({ ...runtime, isPartial: true, result: undefined }, 80));
		assert.ok(running.join("\n").includes(TOOL_BG_RUNNING_ANSI), "running state should paint the ink-violet background");
		assert.ok(!running.join("\n").includes(TOOL_BG_SUCCESS_ANSI), "running must stay distinct from success");

		const failed = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call({
				...runtime,
				result: { isError: true, content: [{ type: "text" }] },
			}, 80));
		assert.ok(failed.join("\n").includes(TOOL_BG_ERROR_ANSI), "failed state should paint the ink-rose background");
		assert.deepEqual(backgroundCalls, [], "no state may consult theme.bg");
	} finally {
		cleanup();
		prototype.render = originalRender;
	}
});
test("tool status background covers Bash success and cancellation at supported widths", () => {
	type RenderPrototype = { render(this: unknown, width: number): string[] };
	const bashPrototype = BashExecutionComponent.prototype as unknown as RenderPrototype;
	const originalRender = bashPrototype.render;
	const backgroundCalls: string[] = [];
	const backgroundTheme = {
		...theme,
		bg: (color: string, text: string) => {
			backgroundCalls.push(color);
			return `\x1b[48;5;242m${text}\x1b[49m`;
		},
	};
	const settings = { toolBackground: true };
	bashPrototype.render = () => ["", "✓ Bash  echo hi", "output", "────"];
	const cleanup = installMessageBorders(() => backgroundTheme as never, settings);

	try {
		for (const [status, expectedBackground] of [
			["complete", TOOL_BG_SUCCESS_ANSI],
			["cancelled", TOOL_BG_CANCELLED_ANSI],
		] as const) {
			for (const width of [40, 80, 160]) {
				backgroundCalls.length = 0;
				const lines = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
					bashPrototype.render.call({
						status,
						command: "echo hi",
						outputLines: ["output"],
						expanded: false,
					}, width));
				const backgroundLines = lines.filter((line) => line.includes(expectedBackground));
				assert.ok(backgroundLines.length > 0, `bash ${status} should carry the fixed state background`);
				assert.deepEqual(backgroundCalls, [], "bash background must not consult theme.bg");
				assert.doesNotMatch(lines[1] ?? "", /\x1b\[48[;:]/, "标题上框不能带状态底色");
				assert.doesNotMatch(lines.at(-1) ?? "", /\x1b\[48[;:]/, "底框不能带状态底色");
				assert.ok(lines.every((line) => visibleWidth(line) <= width), `bash frame must fit width ${width}`);
			}
		}
	} finally {
		cleanup();
		bashPrototype.render = originalRender;
	}
});

test("running tool frames keep wide styled borders stable and low-churn", () => {
	type ToolPrototype = { render(this: unknown, width: number): string[] };
	const prototype = ToolExecutionComponent.prototype as unknown as ToolPrototype;
	const originalRender = prototype.render;
	const frameTheme = {
		...theme,
		bg: (_color: string, text: string) => `\x1b[48;5;240m${text}\x1b[49m`,
	};
	prototype.render = () => [
		"",
		"\x1b[38;2;1;2;3m◇ Edit  target\x1b[39m",
		"\x1b[38;2;1;2;3m中文 📌 内容\x1b[39m",
		"tail",
	];
	const cleanup = installMessageBorders(() => frameTheme as never, { toolBackground: true });
	const originalNow = Date.now;

	try {
		for (const width of [40, 41, 80, 119, 160]) {
			const renderAt = (now: number) => {
				Date.now = () => now;
				return withEnv("PI_READMAP_RENDER_MODE", "color", () =>
					prototype.render.call({ isPartial: true, result: undefined, toolName: "edit" }, width));
			};
			const first = renderAt(0);
			const second = renderAt(80);
			const completed = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
				prototype.render.call({ isPartial: false, result: { isError: false }, toolName: "edit" }, width));
			const firstPlain = first.map(stripAnsi);
			assert.ok(first.slice(1).every((line) => visibleWidth(line) === width), `running frame must fill width ${width}`);
			assert.equal(firstPlain[1]?.at(-1), "╮");
			assert.match(first[1] ?? "", /╮\x1b\[39m$/);
			assert.ok((first[1]?.match(/\x1b\[38;2;/g) ?? []).length < 8,
				"running title border must not color the long rule cell by cell");
			assert.ok(
				firstPlain.slice(2, -1).every((line) => line.endsWith("│")),
				"running body rows must keep the right rail",
			);
			assert.equal(firstPlain.at(-1)?.at(-1), "╯");
			assert.match(first.at(-1) ?? "", /╯\x1b\[39m$/);
			assert.equal((first.at(-1)?.match(/\x1b\[38;2;/g) ?? []).length, 1,
				"running bottom border must use one static color run");
			assert.ok((completed.at(-1)?.match(/\x1b\[38;2;/g) ?? []).length > 1,
				"completed bottom border should retain the Sakura gradient");
			assert.notEqual(first[1], second[1], "running marker should keep animating");
			assert.equal(first.at(-1), second.at(-1), "static bottom corner must not repaint differently");
			assert.deepEqual(first.slice(2), second.slice(2), "标题 spinner 之外的行必须逐字节稳定");
		}
	} finally {
		Date.now = originalNow;
		cleanup();
		prototype.render = originalRender;
	}
});

test("running cards show a live elapsed timer in the title", () => {
	type RenderPrototype = { render(this: unknown, width: number): string[] };
	const prototype = ToolExecutionComponent.prototype as unknown as RenderPrototype;
	const bashPrototype = BashExecutionComponent.prototype as unknown as RenderPrototype;
	const originalRender = prototype.render;
	const originalBashRender = bashPrototype.render;
	let renderToolBody = (): string[] => ["◇ Edit  target", "body"];
	prototype.render = () => renderToolBody();
	bashPrototype.render = () => ["", "$ sleep 99", "output"];
	const cleanup = installMessageBorders(() => theme as never);
	const originalNow = Date.now;

	try {
		// 秒表以组件实例为键：同一 runtime 对象跨帧复用。
		const runtime = {
			isPartial: true,
			result: undefined,
			toolName: "edit",
			hideComponent: false,
			expanded: false,
			showImages: false,
		};
		Date.now = () => 100_000;
		const first = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call(runtime, 80));
		assert.doesNotMatch(stripAnsi(first[0] ?? ""), /· \d+s/, "运行不足 1s 不显示耗时");
		Date.now = () => 105_200;
		const later = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call(runtime, 80));
		assert.match(stripAnsi(later[0] ?? ""), /Edit {2}target · 5s ─+╮$/, "标题里要出现实时耗时");
		assert.ok(later.every((line) => visibleWidth(line) === 80), "耗时不能破坏框宽");

		const settled = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call({
				...runtime,
				isPartial: false,
				result: { isError: false, content: [{ type: "text" }] },
			}, 80));
		assert.doesNotMatch(stripAnsi(settled.join("\n")), /· \d+s/, "完成后的卡片不再显示秒表");

		// 宿主默认 shell 会把标题行 padding 到整宽：秒表必须先剥 padding 再追加，
		// 否则 padding 变成"内部空格"逃过 titleBorder 尾部修剪，右侧横线消失、标题被 … 截断。
		renderToolBody = () => [
			`\x1b[38;2;1;2;3m◇ bash echo hi\x1b[39m${" ".repeat(120)}`,
			"output line",
		];
		const paddedRuntime = { ...runtime, toolName: "bash" };
		Date.now = () => 300_000;
		withEnv("PI_READMAP_RENDER_MODE", "color", () => prototype.render.call(paddedRuntime, 80));
		Date.now = () => 303_000;
		const padded = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			prototype.render.call(paddedRuntime, 80));
		const paddedTitle = stripAnsi(padded[0] ?? "");
		assert.match(paddedTitle, /echo hi · 3s ─+╮$/, "剥掉 padding 后秒表和右侧横线都要在");
		assert.doesNotMatch(paddedTitle, /…/, "放得下的标题不得出现截断省略号");
		assert.doesNotMatch(paddedTitle, / {4,}/, "标题内不得残留整宽 padding");

		// Bash：秒表格式与长命令截断下的 meta 保留。
		const bashRuntime = {
			status: "running" as const,
			command: `while true; do echo ${"x".repeat(120)}; done`,
			outputLines: ["output"],
			expanded: false,
		};
		Date.now = () => 200_000;
		const bashFirst = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			bashPrototype.render.call(bashRuntime, 60));
		assert.doesNotMatch(stripAnsi(bashFirst.join("\n")), /· \d+m? ?\d*s/);
		Date.now = () => 265_000;
		const bashLater = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			bashPrototype.render.call(bashRuntime, 60));
		const bashTitle = stripAnsi(bashLater[1] ?? "");
		assert.match(bashTitle, /· 1m 5s ─+╮$/, "长命令末尾的秒表不得被标题截断吃掉");
		assert.match(bashTitle, /…/, "命令本体按剩余宽度截断");
		assert.ok(bashLater.slice(1).every((line) => visibleWidth(line) === 60), "bash 框宽保持完整");
	} finally {
		Date.now = originalNow;
		cleanup();
		prototype.render = originalRender;
		bashPrototype.render = originalBashRender;
	}
});

test("user messages use a titleless rail frame distinct from tool cards", () => {
	type RenderPrototype = { render(this: unknown, width: number): string[] };
	const userPrototype = UserMessageComponent.prototype as unknown as RenderPrototype;
	const bashPrototype = BashExecutionComponent.prototype as unknown as RenderPrototype;
	const originalUserRender = userPrototype.render;
	const originalBashRender = bashPrototype.render;
	userPrototype.render = () => ["native user"];
	let bashPredecessorWidth = 0;
	bashPrototype.render = (width) => {
		bashPredecessorWidth = width;
		return ["", "────────────────", "\x1b[48;2;80;80;80m $ npm test\x1b[49m", "\x1b[48;5;240m test failed\x1b[49m", " (exit 1)", "────────────────", "────────────────"];
	};
	const cleanup = installMessageBorders(() => theme as never);

	try {
		for (const width of [4, 5, 6]) {
			const fallback = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
				userPrototype.render.call({ text: "中" }, width));
			assert.deepEqual(fallback, ["native user"]);
		}
		const minimumFrame = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			userPrototype.render.call({ text: "中" }, 7));
		assert.match(stripAnsi(minimumFrame.join("\n")), /^╭─────╮\n│ ▌ 中│\n╰─────╯$/);
		const userLines = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			userPrototype.render.call({ text: "hello world" }, 80));
		const userText = stripAnsi(userLines.join("\n"));
		assert.equal(userLines.length, 3);
		assert.match(userText, /^╭─+╮\n│ ▌ hello world\s+│\n╰─+╯$/);
		assert.doesNotMatch(userText, /^╭─ [✓×!⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
		assertNoOverflow(userLines, 80);

		for (const text of ["[paste #1 +11 lines]", "x".repeat(300), "中文".repeat(120)]) {
			for (const width of [8, 10, 20, 40, 80, 160]) {
				const rendered = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
					userPrototype.render.call({ text }, width));
				const plain = rendered.map(stripAnsi);
				assert.ok(rendered.every((line) => visibleWidth(line) === width), `user frame must fill width ${width}`);
				assert.equal(plain[0], `╭${"─".repeat(width - 2)}╮`);
				assert.equal(plain.at(-1), `╰${"─".repeat(width - 2)}╯`);
			}
		}

		const bashLines = withEnv("PI_READMAP_RENDER_MODE", "color", () =>
			bashPrototype.render.call({
				status: "error",
				command: "npm test",
				exitCode: 1,
				outputLines: ["test failed"],
				expanded: false,
			}, 80));
		const bashText = stripAnsi(bashLines.join("\n"));
		assert.match(bashText, /^\n╭─ × Bash  npm test · exit 1 ─+╮/);
		assert.match(bashText, /test failed/);
		assert.match(bashText, /\n┃\s+│\n┃\s+test failed/);
		assert.doesNotMatch(bashLines.join("\n"), /\x1b\[(?:48[;:]|49m)/);
		assert.doesNotMatch(bashText, /┃ × Bash/);
		assert.match(bashText, /\n╰─+╯$/);
		assert.match(bashText, /\n┃\s*─{3,}\s+│\n╰─+╯$/, "真实水平线输出不能被当成宿主下框删除");
		assert.doesNotMatch(bashText, /\(exit 1\)/);
		assertNoOverflow(bashLines, 80);
		assert.equal(bashPredecessorWidth, 78, "Bash 外框的 2 列 chrome 必须先从正文宽度预算中扣除");
	} finally {
		cleanup();
		userPrototype.render = originalUserRender;
		bashPrototype.render = originalBashRender;
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
	assert.match(stripAnsi(plain.render(80).join("\n")), /Read.*3 lines/);
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
	const statsColors: Array<{ color: string; text: string }> = [];
	const statsTheme = {
		fg: (color: string, value: string) => {
			statsColors.push({ color, text: value });
			return value;
		},
		bold: (value: string) => value,
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
		statsTheme,
		{ expanded: false },
	) as { render: (w: number) => string[] };

	const text = stripAnsi(collapsed.render(80).join("\n"));
	assert.match(text, /Edit.*\+10 −10/);
	assert.match(text, /rename|warning/);
	assert.ok(
		statsColors.some((part) => part.color === "toolDiffAdded" && part.text === "+10"),
		"added stat should use toolDiffAdded",
	);
	assert.ok(
		statsColors.some((part) => part.color === "toolDiffRemoved" && part.text === "−10"),
		"removed stat should use toolDiffRemoved",
	);
	// 折叠态有预览，但不铺满全部 20 行
	assert.match(text, /old-0|new-1/);
	assert.match(text, /14 more diff lines · Ctrl\+O/);
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

test("stream reveal adapts without splitting Unicode code points", () => {
	assert.equal(advanceStreamReveal("", "abc"), "a");
	assert.equal(advanceStreamReveal("", "😀x"), "😀");
	assert.equal(advanceStreamReveal("abc", "ax"), "ax");
	assert.equal(advanceStreamReveal("", "x".repeat(1_000)).length, 64);
});

test("write call animates incrementally and flushes when args complete", () => {
	const tool = makeTool("write");
	patchReadmapTool(tool, { writeAnimation: true });
	let invalidations = 0;
	const component = tool.renderCall?.(
		{ path: "src/live.ts", content: "abc" },
		theme,
		{
			argsComplete: false,
			isPartial: true,
			invalidate: () => invalidations++,
		},
	) as {
		render: (width: number) => string[];
		advanceAnimation: () => boolean;
		stop: () => void;
	};
	const initialLines = component.render(80);
	const initial = stripAnsi(initialLines.join("\n"));
	assert.match(initial, /Write.*live\.ts.*0 lines/);
	assert.equal(initialLines.length, 1, "nothing revealed yet: header only, no placeholder row");
	assert.doesNotMatch(initial, /abc|empty file/);

	assert.equal(component.advanceAnimation(), true);
	assert.equal(invalidations, 1);
	assert.match(stripAnsi(component.render(80).join("\n")), /1 │ a$/, "first character reveals without a cursor");

	const complete = tool.renderCall?.(
		{ path: "src/live.ts", content: "abc" },
		theme,
		{ argsComplete: true, isPartial: true, lastComponent: component as never },
	) as { render: (width: number) => string[] };
	const completeText = stripAnsi(complete.render(80).join("\n"));
	assert.match(completeText, /abc/);
	assert.doesNotMatch(completeText, /▏/);
	component.stop();
});


test("parallel write calls keep independent animation state", () => {
	const tool = makeTool("write");
	patchReadmapTool(tool, { writeAnimation: true });
	const left = tool.renderCall?.(
		{ path: "left.ts", content: "left" },
		theme,
		{ argsComplete: false, isPartial: true },
	) as { render: (width: number) => string[]; advanceAnimation: () => boolean; stop: () => void };
	const right = tool.renderCall?.(
		{ path: "right.ts", content: "right" },
		theme,
		{ argsComplete: false, isPartial: true },
	) as { render: (width: number) => string[]; advanceAnimation: () => boolean; stop: () => void };

	assert.notEqual(left, right);
	left.advanceAnimation();
	right.advanceAnimation();
	assert.match(stripAnsi(left.render(80).join("\n")), /1 │ l$/);
	assert.match(stripAnsi(right.render(80).join("\n")), /1 │ r$/);
	assert.doesNotMatch(stripAnsi(left.render(80).join("\n")), /right/);
	assert.doesNotMatch(stripAnsi(right.render(80).join("\n")), /left/);
	left.stop();
	right.stop();
});


test("shared write timer isolates a failing component", (t) => {
	// node:test 的 mock timers 拦截全局 setInterval/clearInterval，测试结束自动还原。
	t.mock.timers.enable({ apis: ["setInterval"] });

	const tool = makeTool("write");
	patchReadmapTool(tool, { writeAnimation: true });
	let rightInvalidations = 0;
	const left = tool.renderCall?.(
		{ path: "left.ts", content: "left" },
		theme,
		{ argsComplete: false, isPartial: true, invalidate: () => { throw new Error("detached row"); } },
	) as { render: (width: number) => string[]; stop: () => void };
	const right = tool.renderCall?.(
		{ path: "right.ts", content: "right" },
		theme,
		{ argsComplete: false, isPartial: true, invalidate: () => rightInvalidations++ },
	) as { render: (width: number) => string[]; stop: () => void };

	try {
		assert.doesNotThrow(() => t.mock.timers.tick(40), "shared tick must survive a throwing invalidate");
		assert.equal(rightInvalidations, 1, "healthy component should keep animating after a peer fails");
		assert.match(stripAnsi(left.render(80).join("\n")), /1 │ l$/, "failed component freezes at its last reveal");
		assert.match(stripAnsi(right.render(80).join("\n")), /1 │ r$/, "healthy component keeps revealing content");
	} finally {
		left.stop();
		right.stop();
	}
});

test("write bounds colored rendering for a 200k single line", () => {
	const tool = makeTool("write");
	patchReadmapTool(tool, { writeAnimation: false });
	const component = tool.renderCall?.(
		{ path: "src/huge.ts", content: `START_MARKER${"x".repeat(200_000)}END_MARKER` },
		theme,
		{ argsComplete: true, isPartial: true, expanded: false },
	) as { render: (width: number) => string[] };
	const start = performance.now();
	const lines = component.render(80);
	const elapsedMs = performance.now() - start;
	const text = stripAnsi(lines.join("\n"));

	assert.equal(lines.length, 9);
	assertNoOverflow(lines, 80);
	assert.match(text, /END_MARKER/);
	assert.doesNotMatch(text, /START_MARKER/);
	assert.ok(elapsedMs < 2_000, `200k folded write took ${Math.round(elapsedMs)}ms`);
});

test("write call stays visible without animation and keeps eight terminal rows", () => {
	const tool = makeTool("write");
	patchReadmapTool(tool, { writeAnimation: false });
	const content = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n");
	const collapsed = tool.renderCall?.(
		{ path: "src/static.ts", content },
		theme,
		{ argsComplete: false, isPartial: true, expanded: false },
	) as { render: (width: number) => string[] };
	const collapsedText = stripAnsi(collapsed.render(80).join("\n"));
	const numbered = collapsedText.split("\n").filter((line) => /^\s*\d+\s+│/.test(line));
	assert.equal(numbered.length, 8);
	assert.match(collapsedText, /5 │ line-5/);
	assert.match(collapsedText, /12 │ line-12/);
	assert.doesNotMatch(collapsedText, /1 │ line-1(?:\n|$)/);
	assert.doesNotMatch(collapsedText, /▏/);
	assert.match(collapsedText, /Ctrl\+O/);

	const expanded = tool.renderCall?.(
		{ path: "src/static.ts", content },
		theme,
		{ argsComplete: false, isPartial: true, expanded: true, lastComponent: collapsed as never },
	) as { render: (width: number) => string[] };
	const expandedText = stripAnsi(expanded.render(80).join("\n"));
	assert.match(expandedText, /1 │ line-1/);
	assert.match(expandedText, /12 │ line-12/);

	const longLine = tool.renderCall?.(
		{ path: "src/long.ts", content: "界".repeat(100) },
		theme,
		{ argsComplete: true, isPartial: true, expanded: false },
	) as { render: (width: number) => string[] };
	const longRows = longLine.render(18);
	assert.equal(longRows.length, 9);
	assertNoOverflow(longRows, 18);
});

test("write screen-reader mode is static and labels source lines", () => {
	const tool = makeTool("write");
	patchReadmapTool(tool, { writeAnimation: true });
	const component = withEnv("PI_READMAP_RENDER_MODE", "screen-reader", () => tool.renderCall?.(
		{ path: "notes.txt", content: "first\nsecond" },
		theme,
		{ argsComplete: false, isPartial: true },
	)) as { render: (width: number) => string[] };
	const text = component.render(80).join("\n");
	assert.match(text, /line 1: first/);
	assert.match(text, /line 2: second/);
	assert.doesNotMatch(text, /▏/);
});


test("write plain mode is static without a cursor", () => {
	const tool = makeTool("write");
	patchReadmapTool(tool, { writeAnimation: true });
	const plain = withEnv("PI_READMAP_RENDER_MODE", "plain", () => tool.renderCall?.(
		{ path: "notes.txt", content: "plain text" },
		theme,
		{ argsComplete: false, isPartial: true },
	)) as { render: (width: number) => string[] };
	const plainText = plain.render(80).join("\n");
	assert.match(plainText, /plain text/);
	assert.doesNotMatch(plainText, /▏|\x1b\[/);
});

test("write create keeps final tail, expands fully, and overwrite keeps diff", () => {
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
	const collapsedRows = collapsedText.split("\n").filter((line) => /^\s*\d+\s+│/.test(line));
	assert.match(collapsedText, /Create/);
	assert.match(collapsedText, /40 lines/);
	assert.equal(collapsedRows.length, 8);
	assert.match(collapsedText, /33 │ line-32/);
	assert.match(collapsedText, /40 │ line-39/);
	assert.doesNotMatch(collapsedText, /line-0/);
	assert.doesNotMatch(collapsedText, /\d+:aaa\|/);

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
	assert.match(createdText, /Create/);
	assert.match(createdText, /1 │ line-0/);
	assert.match(createdText, /40 │ line-39/);
	assert.match(createdText, /\n\s*2 │\s*\n/);
	assert.doesNotMatch(createdText, /more lines/);
	assert.doesNotMatch(createdText, /\d+:aaa\|/);
	assert.doesNotMatch(createdText, /▌\+/);

	const empty = tool.renderResult?.(
		{ content: [{ type: "text", text: "ok" }], details: { writeState: "created" } },
		{ expanded: false },
		theme,
		{ args: { path: "empty.txt", content: "" }, expanded: false },
	) as { render: (width: number) => string[] };
	assert.match(stripAnsi(empty.render(80).join("\n")), /empty file/);

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
	assert.match(overText, /Overwrite/);
	assert.doesNotMatch(overText, /↳ diff/);
	assert.match(overText, /▌/);
});

test("write failure keeps the final eight rows and marks content as not written", () => {
	const tool = makeTool("write");
	patchReadmapTool(tool);
	const content = Array.from({ length: 12 }, (_, index) => `failed-${index + 1}`).join("\n");
	const failed = tool.renderResult?.(
		{ content: [{ type: "text", text: "permission denied" }], isError: true },
		{ expanded: false },
		theme,
		{
			args: { path: "src/failed.ts", content },
			expanded: false,
			isError: true,
		},
	) as { render: (width: number) => string[] };
	const text = stripAnsi(failed.render(80).join("\n"));
	const rows = text.split("\n").filter((line) => /^\s*\d+\s+│/.test(line));
	assert.match(text, /permission denied/);
	assert.match(text, /not written/);
	assert.equal(rows.length, 8);
	assert.match(text, /12 │ failed-12/);
	assert.doesNotMatch(text, /1 │ failed-1(?:\n|$)/);
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
	assert.match(shortText, /Bash.*2 lines/);
	assert.match(shortText, /pass/);

	const longBody = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
	const long = tool.renderResult?.(
		{ content: [{ type: "text", text: longBody }] },
		{ expanded: false },
		theme,
		{ expanded: false },
	) as { render: (w: number) => string[] };
	const longText = stripAnsi(long.render(80).join("\n"));
	assert.match(longText, /Bash.*40 lines/);
	assert.match(longText, /line-36/); // 成功命令优先显示末尾摘要
	assert.match(longText, /36 more lines · Ctrl\+O/);
	assert.match(longText, /line-39/);
	assert.doesNotMatch(longText, /line-0(?:\n|$)/);

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
	assert.match(stripAnsi(failed.render(80).join("\n")), /\n┃ rest/);
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
	assert.match(callText, /Ls/);
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
	assert.match(collapsedText, /20 entries/);
	assert.match(collapsedText, /▸ src\//);
	assert.match(collapsedText, /file-1\.ts/);
	assert.match(collapsedText, /Ctrl\+O/);
	assert.match(collapsedText, /12 more entries/);
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
	assert.match(stripAnsi(empty.render(80).join("\n")), /Ls.*empty/);

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

test("DiffBodyComponent and tool renders stay within 40/60/80/100/120/160 columns", () => {
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

	for (const width of [40, 60, 80, 100, 120, 160]) {
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

	for (const width of [40, 60, 80, 100, 120, 160]) {
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
	assert.ok(visibleWidth(line) <= 40, "clampLine must not exceed the requested width");
});
