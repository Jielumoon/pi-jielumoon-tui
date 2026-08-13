import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import installReadmapRenderers, { patchReadmapTool, READMAP_RENDERER_MARK } from "../src/readmap-renderers/index.ts";
import { renderFindResult, renderGrepResult } from "../src/readmap-renderers/results.ts";

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

/** 把颜色通道写进文本，供高亮/分组断言使用。 */
const markTheme = {
	fg: (color: string, text: string) => `«${color}:${text}»`,
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
	return {
		name,
		execute: () => ({ content: [{ type: "text", text: "ok" }] }),
		parameters: { kind: "object" },
		description: `${name} tool`,
		renderCall: () => ({ render: () => ["old-call"] }),
		renderResult: () => ({ render: () => ["old-result"] }),
	};
}

type Renderable = { render: (width: number) => string[] };

function textResult(text: string, details?: unknown): { content: Array<{ type: string; text: string }>; details?: unknown } {
	return { content: [{ type: "text", text }], details };
}

function renderedText(component: unknown, width = 200): string {
	return stripAnsi((component as Renderable).render(width).join("\n"));
}

test("patchReadmapTool takes over grep and find with canonical running headers", () => {
	const grep = makeTool("grep");
	const find = makeTool("find");
	assert.equal(patchReadmapTool(grep), true);
	assert.equal(patchReadmapTool(find), true);
	assert.equal(grep.renderShell, "self");
	assert.equal(find.renderShell, "self");
	assert.equal(patchReadmapTool(grep), false, "重复 patch 必须幂等");

	const grepCall = grep.renderCall?.(
		{ pattern: "value", path: "src", glob: "*.ts", ignoreCase: true, context: 2, limit: 50 },
		theme,
		{ isPartial: true, cwd: "/tmp" },
	) as Renderable;
	const grepHead = stripAnsi(grepCall.render(160)[0] ?? "");
	assert.match(grepHead, /^◇ Grep {2}\/value\/ in src/);
	assert.match(grepHead, /glob: \*\.ts/);
	assert.match(grepHead, /-i/);
	assert.match(grepHead, /±2/);
	assert.match(grepHead, /limit: 50/);

	const findCall = find.renderCall?.(
		{ pattern: "**/*.spec.ts", limit: 10 },
		theme,
		{ isPartial: true, cwd: "/tmp" },
	) as Renderable;
	const findHead = stripAnsi(findCall.render(160)[0] ?? "");
	assert.match(findHead, /^◇ Find {2}\*\*\/\*\.spec\.ts in \./);
	assert.match(findHead, /limit: 10/);

	// 参数缺失时占位，不崩溃
	const emptyCall = grep.renderCall?.({}, theme, { isPartial: true }) as Renderable;
	assert.match(stripAnsi(emptyCall.render(80)[0] ?? ""), /^◇ Grep {2}… in \./);
});

test("core tool bridge patches session definitions through getRenderShell", () => {
	const registered: unknown[] = [];
	const pi = {
		events: { on: () => {} },
		registerTool: (tool: unknown) => registered.push(tool),
		on: () => {},
	} as unknown as ExtensionAPI;
	installReadmapRenderers(pi);

	type ShellPrototype = { getRenderShell(this: unknown): string };
	const prototype = ToolExecutionComponent.prototype as unknown as ShellPrototype;

	const sessionGrep = makeTool("grep");
	const grepReceiver = { toolName: "grep", toolDefinition: sessionGrep, builtInToolDefinition: undefined };
	assert.equal(prototype.getRenderShell.call(grepReceiver), "self", "桥接后 grep 必须走 self shell");
	assert.equal(sessionGrep[READMAP_RENDERER_MARK], true);
	assert.equal(sessionGrep.renderShell, "self");
	assert.notEqual(sessionGrep.renderCall, undefined);

	// session 注册表缺失时回退到组件私有的内置定义
	const builtInFind = makeTool("find");
	const findReceiver = { toolName: "find", toolDefinition: undefined, builtInToolDefinition: builtInFind };
	assert.equal(prototype.getRenderShell.call(findReceiver), "self");
	assert.equal(builtInFind[READMAP_RENDERER_MARK], true);

	// 非目标工具原样透传
	const todo = makeTool("todo");
	const todoRenderCall = todo.renderCall;
	const todoReceiver = { toolName: "todo", toolDefinition: todo, builtInToolDefinition: undefined };
	assert.equal(prototype.getRenderShell.call(todoReceiver), "default");
	assert.equal(todo[READMAP_RENDERER_MARK], undefined);
	assert.equal(todo.renderCall, todoRenderCall, "todo renderer 不得被替换");
});

test("grep result groups matches by file and highlights the pattern", () => {
	const body = [
		"src/app.ts:3: const value = 1",
		"src/app.ts:12: value += 2",
		"src/lib/util.ts:8: return value",
	].join("\n");
	const component = renderGrepResult(
		textResult(body),
		{ expanded: true },
		markTheme,
		{ args: { pattern: "value", path: "." }, expanded: true },
	) as Renderable;
	const text = component.render(400).join("\n");

	assert.match(text, /3 matches/);
	assert.match(text, /2 files/);
	assert.equal(text.match(/«syntaxType:src\/app\.ts»/g)?.length, 1, "同文件的匹配必须归到一个分组头");
	assert.equal(text.match(/«syntaxType:src\/lib\/util\.ts»/g)?.length, 1);
	assert.ok((text.match(/«accent:value»/g)?.length ?? 0) >= 3, "每个匹配行都要高亮匹配词");
	assert.match(text, /«dim: 3»«muted::»/, "行号按最大宽度右对齐");
	assert.match(text, /«dim:12»«muted::»/);
});

test("grep classifies ambiguous separators and dims context lines", () => {
	const body = [
		"src/a-1.ts-2- before :9: tricky",
		"src/a-1.ts:3: hit",
		"src/a-1.ts-4- after",
	].join("\n");
	const component = renderGrepResult(
		textResult(body),
		{ expanded: true },
		markTheme,
		{ args: { pattern: "hit" }, expanded: true },
	) as Renderable;
	const text = component.render(400).join("\n");

	assert.match(text, /1 match\b/, "上下文行不能计入匹配数");
	assert.match(text, /«dim:before :9: tricky»/, "正文里的 `:9: ` 不得把上下文行误判成匹配");
	assert.match(text, /«dim:after»/);
	assert.match(text, /«accent:hit»/);
	assert.equal(text.match(/«syntaxType:src\/a-1\.ts»/g)?.length, 1);
});

test("grep collapses to six matches and expands fully", () => {
	const body = Array.from({ length: 10 }, (_, i) => `src/app.ts:${i + 1}: line ${i + 1}`).join("\n");
	const collapsed = renderGrepResult(
		textResult(body),
		{ expanded: false },
		theme,
		{ args: { pattern: "line" } },
	) as Renderable;
	const collapsedText = renderedText(collapsed);
	assert.match(collapsedText, /10 matches/);
	assert.match(collapsedText, /line 6/);
	assert.doesNotMatch(collapsedText, /line 7/);
	assert.match(collapsedText, /… 4 more matches · Ctrl\+O/);
	assert.match(collapsedText.split("\n")[0] ?? "", /Ctrl\+O/, "折叠头部要给展开提示");

	const expanded = renderGrepResult(
		textResult(body),
		{ expanded: true },
		theme,
		{ args: { pattern: "line" }, expanded: true },
	) as Renderable;
	const expandedText = renderedText(expanded);
	assert.match(expandedText, /line 10/);
	assert.doesNotMatch(expandedText, /more matches/);
});

test("grep handles no matches, truncation notices, errors, and partial calls", () => {
	const empty = renderGrepResult(
		textResult("No matches found"),
		{ expanded: false },
		theme,
		{ args: { pattern: "nope" } },
	) as Renderable;
	assert.match(renderedText(empty), /✓ Grep {2}\/nope\/ in \. · no matches/);

	const noticed = renderGrepResult(
		textResult(
			"src/a.ts:1: x\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]",
			{ matchLimitReached: 100 },
		),
		{ expanded: true },
		theme,
		{ args: { pattern: "x" }, expanded: true },
	) as Renderable;
	const noticedText = renderedText(noticed);
	assert.match(noticedText, /truncated/);
	assert.doesNotMatch(noticedText, /limit reached/, "尾部通知行不得混进匹配正文");

	const failed = renderGrepResult(
		{ ...textResult("grep failed\nboom"), isError: true },
		{ expanded: false },
		theme,
		{ args: { pattern: "x" } },
	) as Renderable;
	const failedText = renderedText(failed);
	assert.match(failedText, /× Grep/);
	assert.match(failedText, /grep failed/);

	const partial = renderGrepResult(
		textResult("ignored"),
		{ isPartial: true },
		theme,
		{ args: { pattern: "x" }, isPartial: true },
	) as Renderable;
	assert.deepEqual(partial.render(80), [], "partial 阶段由 renderCall 负责，结果渲染必须为空");
});

test("grep highlight degrades safely on hostile patterns", () => {
	const render = (pattern: unknown, body: string, extra: Record<string, unknown> = {}): string => {
		const component = renderGrepResult(
			textResult(body),
			{ expanded: true },
			markTheme,
			{ args: { pattern, ...extra }, expanded: true },
		) as Renderable;
		return component.render(400).join("\n");
	};

	// 标题里的 pattern 本身是 accent 高亮，断言只针对正文行。
	const nested = render("(a+)+", "src/a.ts:1: aaaa");
	assert.doesNotMatch(nested, /«accent:a+»/, "嵌套量词必须放弃正文高亮");
	assert.match(nested, /«toolOutput:aaaa»/);

	const invalid = render("(", "src/a.ts:1: (open");
	assert.doesNotMatch(invalid, /«accent:\(open»/);
	assert.match(invalid, /«toolOutput:\(open»/);

	const literal = render("a.b", "src/a.ts:1: a.b axb", { literal: true });
	assert.equal(literal.match(/«accent:a\.b»/g)?.length, 1, "literal 模式按原文高亮");
	assert.doesNotMatch(literal, /«accent:axb»/);

	const caseless = render("value", "src/a.ts:1: VALUE", { ignoreCase: true });
	assert.match(caseless, /«accent:VALUE»/);
});

test("find renders entries like ls with collapse and dir markers", () => {
	const paths = [
		...Array.from({ length: 11 }, (_, i) => `src/file-${i + 1}.ts`),
		"src/nested/",
	];
	const collapsed = renderFindResult(
		textResult(paths.join("\n")),
		{ expanded: false },
		theme,
		{ args: { pattern: "*.ts", path: "src" } },
	) as Renderable;
	const collapsedText = stripAnsi(collapsed.render(80).join("\n"));
	assert.match(collapsedText, /✓ Find {2}\*\.ts in src · 12 results/);
	assert.match(collapsedText, /· src\/file-1\.ts/);
	assert.match(collapsedText, /· src\/file-8\.ts/);
	assert.doesNotMatch(collapsedText, /file-9\.ts/);
	assert.match(collapsedText, /… 4 more results · Ctrl\+O/);

	const expanded = renderFindResult(
		textResult(paths.join("\n")),
		{ expanded: true },
		theme,
		{ args: { pattern: "*.ts", path: "src" }, expanded: true },
	) as Renderable;
	const expandedText = stripAnsi(expanded.render(80).join("\n"));
	assert.match(expandedText, /· src\/file-11\.ts/);
	assert.match(expandedText, /▸ src\/nested\//, "目录条目保留 ▸ 与尾随斜杠");
	assert.doesNotMatch(expandedText, /more results/);
});

test("find handles empty results, truncation, errors, and partial calls", () => {
	const empty = renderFindResult(
		textResult("No files found matching pattern"),
		{ expanded: false },
		theme,
		{ args: { pattern: "*.nope" } },
	) as Renderable;
	assert.match(renderedText(empty), /✓ Find {2}\*\.nope in \. · no files/);

	const truncatedResult = renderFindResult(
		textResult("src/a.ts\n\n[1000 results limit reached]", { resultLimitReached: 1000 }),
		{ expanded: true },
		theme,
		{ args: { pattern: "*" }, expanded: true },
	) as Renderable;
	const truncatedText = renderedText(truncatedResult);
	assert.match(truncatedText, /truncated/);
	assert.doesNotMatch(truncatedText, /limit reached/);

	const failed = renderFindResult(
		{ ...textResult("find failed\nPath not found: /nope"), isError: true },
		{ expanded: false },
		theme,
		{ args: { pattern: "*" } },
	) as Renderable;
	assert.match(renderedText(failed), /× Find/);

	const partial = renderFindResult(
		textResult("ignored"),
		{ isPartial: true },
		theme,
		{ args: { pattern: "*" }, isPartial: true },
	) as Renderable;
	assert.deepEqual(partial.render(80), [], "partial 阶段由 renderCall 负责，结果渲染必须为空");
});

test("grep and find results read cleanly in screen-reader mode", () => {
	const previous = process.env.PI_READMAP_RENDER_MODE;
	process.env.PI_READMAP_RENDER_MODE = "screen-reader";
	try {
		const grep = renderGrepResult(
			textResult("src/a.ts:3: hit\nsrc/a.ts-4- after"),
			{ expanded: true },
			theme,
			{ args: { pattern: "hit" }, expanded: true },
		) as Renderable;
		const grepText = grep.render(80).join("\n");
		assert.match(grepText, /grep complete:/);
		assert.match(grepText, /match: src\/a\.ts:3: hit/);
		assert.match(grepText, /context: src\/a\.ts:4: after/);
		assert.doesNotMatch(grepText, /\x1b/);

		const find = renderFindResult(
			textResult("src/a.ts\nsrc/lib/"),
			{ expanded: true },
			theme,
			{ args: { pattern: "*" }, expanded: true },
		) as Renderable;
		const findText = find.render(80).join("\n");
		assert.match(findText, /find complete:/);
		assert.match(findText, /entry: · src\/a\.ts/);
		assert.match(findText, /entry: ▸ src\/lib\//);
		assert.doesNotMatch(findText, /\x1b/);
	} finally {
		if (previous === undefined) delete process.env.PI_READMAP_RENDER_MODE;
		else process.env.PI_READMAP_RENDER_MODE = previous;
	}
});
