import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../src/ansi.ts";
import { installMessageBorders } from "../src/message-borders.ts";
import { patchReadmapTool } from "../src/readmap-renderers/patch.ts";
import { renderCodemodeCall, renderCodemodeResult } from "../src/readmap-renderers/codemode.ts";
import { parseCodemodeArgs, previewCodemodeCalls } from "../src/readmap-renderers/codemode-preview.ts";
import { renderToolHeader } from "../src/readmap-renderers/header.ts";
import { resolvePresentation } from "../src/readmap-renderers/presentation.ts";

process.env.PI_READMAP_RENDER_MODE = "color";

test("Codemode 长路径按终端宽度折行，不沿用普通卡片的 48 列缩写", () => {
	const path = "docs/superpowers/plans/2026-04-10-home-information-architecture-phase1-implementation.md";
	const args = { input: `*** Begin Patch\n*** Add File: ${path}\n+${"x".repeat(300)}\n*** End Patch` };
	const calls = [
		{ name: "apply_patch", args: JSON.stringify(args).slice(0, 197) + "...", status: "ok", durationMs: 61 },
		{ name: "read", args: JSON.stringify({ path }), status: "ok" },
	];
	const component = renderCodemodeResult({ content: [], details: { calls } }, {}, undefined, {});
	const wide = component.render(180).map(stripAnsi);
	assert.ok(wide[1]!.includes(path));
	assert.ok(wide[2]!.includes(path));
	const narrow = component.render(60).map(stripAnsi);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 60));
	assert.ok(narrow.some((line) => line.startsWith("     │")));
	assert.ok(narrow.map((line) => line.replace(/^     [│ ]   /, "")).join("").includes(path));
	const card = stripAnsi(renderToolHeader("apply_patch", args, resolvePresentation(undefined), {}, { phase: "success" }));
	assert.ok(!card.includes(path), "普通卡片仍保持原有路径缩写");
});

test("Codemode 未闭合补丁字符串恢复转义，生成期即可显示路径", () => {
	const patch = "*** Begin Patch\n*** Update File: config/test.yaml\n@@\n-a\n+b";
	for (const quote of ['"', "'"]) {
		const literal = quote + patch.replaceAll("\n", "\\n");
		for (const suffix of ["", "\\"]) {
			const code = `tools.apply_patch({input: ${literal}${suffix}`;
			assert.equal(parseCodemodeArgs(previewCodemodeCalls(code)[0]!.args)?.input, patch);
			const lines = renderCodemodeCall({ code }, undefined, {}).render(100).map(stripAnsi).join("\n");
			assert.match(lines, /◇ Apply_patch  config\/test.yaml/);
		}
	}
});

test("Codemode 标签固定淡紫，不跟随蓝色主题，纯文本模式不注入颜色", () => {
	const blueTheme = { fg: (_color: string, text: string) => `\u001b[34m${text}\u001b[39m`, bold: (text: string) => text };
	const context = { args: { code: "return 5;" } };
	const lavenderLabel = "\u001b[38;2;199;184;245mCodemode";
	assert.ok(renderCodemodeCall(context.args, blueTheme, {}).render(100).join("\n").includes(lavenderLabel));
	const result = { content: [{ type: "text", text: "5" }], details: { calls: [] } };
	assert.ok(renderCodemodeResult(result, {}, blueTheme, context).render(100).join("\n").includes(lavenderLabel));
	const previous = process.env.PI_READMAP_RENDER_MODE;
	try {
		process.env.PI_READMAP_RENDER_MODE = "plain";
		assert.doesNotMatch(renderCodemodeResult(result, {}, blueTheme, context).render(100).join("\n"), /\u001b/);
	} finally {
		process.env.PI_READMAP_RENDER_MODE = previous;
	}
});

function makeComponent() {
	initTheme("dark");
	const tool = {
		name: "codemode",
		execute: () => undefined,
		parameters: {},
		renderCall: () => new Text("原生脚本", 0, 0),
		renderResult: () => new Text("原生输出", 0, 0),
	};
	const execute = tool.execute;
	const parameters = tool.parameters;
	assert.equal(patchReadmapTool(tool), true);
	assert.equal(patchReadmapTool(tool), false);
	assert.equal(tool.execute, execute);
	assert.equal(tool.parameters, parameters);
	return new ToolExecutionComponent("codemode", "call-1", { code: "text('脚本内容')" },
		{ showImages: false }, tool as never, { requestRender() {} } as never, process.cwd());
}

test("Codemode 默认只显示完整调用树，展开才显示脚本和输出", () => {
	const cleanup = installMessageBorders(() => undefined);
	try {
		const component = makeComponent();
		assert.match(component.render(100).map(stripAnsi).join("\n"), /Codemode/);
		assert.doesNotMatch(component.render(100).map(stripAnsi).join("\n"), /脚本内容/);
		component.setExpanded(true);
		const running = component.render(100).map(stripAnsi).join("\n");
		assert.match(running, /text\('脚本内容'\)/, "尚无结果时，运行中的 Ctrl+O 仍应展开脚本");
		assert.equal((running.match(/Codemode/g) ?? []).length, 1);
		component.setExpanded(false);
		const calls = [
			{ name: "read", args: '{"path":"README.md"}', status: "ok", durationMs: 30 },
			{ name: "bash", args: '{"command":"git status --short"}', status: "ok", durationMs: 64 },
		];
		const result = { content: [{ type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
			{ type: "text" as const, text: `{"输出":"${"x".repeat(20_000)}TAIL"}` }], details: { calls }, isError: false };
		component.updateResult(result);
		assert.deepEqual(component.render(100).map(stripAnsi).filter(Boolean), [
			"  ✓ Codemode · 2 次调用 · Ctrl+O",
			"       ├─→ ✓ Read  README.md · 30ms",
			"       ╰─→ ✓ Bash  git status --short · 64ms",
		]);
		const many = Array.from({ length: 10 }, (_, index) => ({ ...calls[0], args: JSON.stringify({ path: `file-${index}.ts` }) }));
		component.updateResult({ ...result, details: { calls: many } });
		assert.equal(component.render(100).map(stripAnsi).filter(Boolean).length, 11);
		assert.match(component.render(100).map(stripAnsi).at(-1)!, /╰─→ ✓ Read  file-9.ts/);
		component.setExpanded(true);
		const expanded = component.render(100).map(stripAnsi).join("\n");
		assert.match(expanded, /text\('脚本内容'\)/);
		assert.match(expanded, /TAIL/);
		assert.ok(expanded.split("\n").length > 200, "展开不得丢弃长单行输出");
		assert.doesNotMatch(expanded, /Script completed|Wall time/);
		component.setExpanded(false);
		assert.doesNotMatch(component.render(100).map(stripAnsi).join("\n"), /脚本内容|输出/);
	} finally {
		cleanup();
	}
});

test("Codemode 部分结果、子失败、截断参数与父错误仍可辨认且净化文本", () => {
	const cleanup = installMessageBorders(() => undefined);
	try {
		const component = makeComponent();
		const calls = [
			{ name: "read", args: '{"path":"README.md"}', status: "running" },
			{ name: "bash", args: JSON.stringify({ command: "echo \u001b[2J检查" }), status: "error", durationMs: 1200, error: "失败\u001b[2J" },
			{ name: "mcp__sample", args: '{"query":"截断...', status: "cancelled" },
		];
		component.updateResult({ content: [], details: { calls }, isError: false }, true);
		let lines = component.render(100).map(stripAnsi).filter(Boolean);
		assert.equal(lines.length, 4, "部分结果不能出现重复标题或额外竖线行");
		assert.match(lines[2]!, /× Bash  echo 检查 · 1\.2s/);
		assert.match(lines[3]!, /cancelled/);
		assert.equal(lines.filter((line) => line.includes("Codemode")).length, 1);
		component.updateResult({ content: [{ type: "text", text: "已捕获子失败" }], details: { calls: calls.slice(1) }, isError: false });
		assert.match(component.render(100).map(stripAnsi).join("\n"), /✓ Codemode/);
		component.updateResult({ content: [{ type: "text", text: "Script failed\nWall time 1 seconds\nOutput:\n" },
			{ type: "text", text: "Script error:\nError: 父脚本失败\u001b[2J" }], details: {}, isError: true });
		lines = component.render(100).map(stripAnsi).filter(Boolean);
		assert.match(lines[0]!, /× Codemode/);
		component.setExpanded(true);
		const expanded = component.render(40);
		assert.match(expanded.map(stripAnsi).join("\n"), /父脚本失败/);
		assert.ok(expanded.every((line) => !line.includes("\u001b[2J") && visibleWidth(line) <= 40));
	} finally {
		cleanup();
	}
});

test("Codemode 生成期逐条预览，真实记录接替且截断参数换行不断树", () => {
	const cleanup = installMessageBorders(() => undefined);
	try {
		const component = makeComponent();
		const view = () => component.render(80).map(stripAnsi).filter(Boolean).join("\n");
		component.updateArgs({ code: '// tools.read({path:"假调用"})\nconst s = "tools.bash()"; const r = /tools.read()/; const t = `tools.read()`;\ntools.read(' });
		assert.match(view(), /╰─→ ◇ Read/);
		assert.doesNotMatch(view(), /假调用|Bash/);
		component.updateArgs({ code: "await Promise.all([tools.read({path:'README" });
		assert.match(view(), /Read  README/);
		component.updateArgs({ code: "await Promise.all([tools.read({path:'README.md'}), tools.bash({command:'git st" });
		assert.match(view(), /├─→ ◇ Read  README.md/);
		assert.match(view(), /╰─→ ◇ Bash  git st/);
		assert.doesNotMatch(view(), /生成中|待执行/);
		assert.equal((view().match(/Codemode/g) ?? []).length, 1);
		const preview = component.render(80).map(stripAnsi).filter(Boolean);
		component.markExecutionStarted();
		assert.deepEqual(component.render(80).map(stripAnsi).filter(Boolean).slice(1), preview.slice(1),
			"执行开始至首次真实记录之间不能先清空子树");
		component.updateResult({ content: [], details: { calls: [{ name: "read", args: '{"path":"README.md"}', status: "running" }] }, isError: false }, true);
		assert.match(view(), /1 次调用.*1 项预览/);
		assert.match(view(), /╰─→ ◇ Bash  git st/);
		assert.equal(component.render(80).map(stripAnsi).filter(Boolean).length, preview.length,
			"首条真实记录应逐条接替，不能移除尚未执行的预览");
		const command = "git ls-files -- .trellis plan backend/bin backend/internal/web/dist; git check-ignore -v .trellis/tasks/09-30-sync-upstream-v0.2.11/prd.md backend/bin/server backend/internal/web/dist/index.html backend/internal/web/dist/assets";
		const truncated = JSON.stringify({ command }).slice(0, 197) + "...";
		assert.equal(truncated.length, 200);
		assert.throws(() => JSON.parse(truncated), "必须覆盖真实被截断的参数，而非完整 JSON");
		component.updateResult({ content: [], details: { calls: [
			{ name: "bash", args: truncated, status: "ok", durationMs: 49 },
			{ name: "read", args: '{"path":"validation.md"}', status: "ok", durationMs: 41 },
		] }, isError: false });
		const lines = component.render(80).map(stripAnsi).filter(Boolean);
		assert.match(lines[1]!, /├─→ ✓ Bash  git ls-files/);
		assert.doesNotMatch(lines.join("\n"), /\{"command"/);
		assert.ok(lines.slice(2, -1).length > 0);
		assert.ok(lines.slice(2, -1).every((line) => line.startsWith("       │")), "子调用续行必须接上竖线");
		assert.match(lines.at(-1)!, /╰─→ ✓ Read  validation.md/);
	} finally {
		cleanup();
	}
});

test("Codemode 重复调用逐条接替，结束移除未执行预览且隐藏组件不读源码", () => {
	const state: Record<string, unknown> = {};
	const args = { code: "await tools.read({path:'same.md'}); await tools.read({path:'same.md'}); if (false) tools.bash({command:'echo skipped'});" };
	renderCodemodeCall(args, undefined, { state });
	const calls = [
		{ name: "read", args: '{"path":"same.md"}', status: "ok", durationMs: 4 },
		{ name: "read", args: '{"path":"same.md"}', status: "running" },
	];
	const result = { content: [], details: { calls } };
	const context = { state, args };
	const partial = renderCodemodeResult(result, { isPartial: true }, undefined, context).render(100).map(stripAnsi);
	assert.match(partial[0]!, /2 次调用.*1 项预览/);
	assert.equal(partial.filter((line) => line.includes("Read  same.md")).length, 2);
	assert.match(partial.at(-1)!, /◇ Bash  echo skipped/);
	const final = renderCodemodeResult(result, {}, undefined, context).render(100).map(stripAnsi);
	assert.equal(final.length, 3);
	assert.doesNotMatch(final.join("\n"), /预览|skipped/);
	const hiddenArgs = { get code(): string { return assert.fail("已隐藏的 call 组件不应再读取或解析源码"); } };
	assert.deepEqual(renderCodemodeCall(hiddenArgs, undefined, { state }).render(100), []);
});

test("Codemode 错误摘要优先真实异常，截断补丁参数仍保留路径与换行", () => {
	const result = { content: [
		{ type: "text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" },
		{ type: "text", text: "普通输出: 开始读取" },
		{ type: "text", text: "Script error:\nError: 实际错误: 读取失败" },
	], details: { calls: [] }, isError: true };
	const collapsed = renderCodemodeResult(result, {}, undefined, {}).render(120).map(stripAnsi).join("\n");
	assert.match(collapsed, /实际错误: 读取失败/);
	assert.doesNotMatch(collapsed, /普通输出/);
	const patch = "*** Begin Patch\n*** Update File: config/comet-state.yaml\n@@\n-old\n+" + "x".repeat(300) + "\n*** End Patch";
	const raw = JSON.stringify({ input: patch }).slice(0, 197) + "...";
	assert.match(String(parseCodemodeArgs(raw)?.input), /\n\*\*\* Update File: config\/comet-state.yaml\n/);
	const lines = renderCodemodeResult({ content: [], details: { calls: [
		{ name: "apply_patch", args: raw, status: "ok", durationMs: 57 },
	] } }, {}, undefined, {}).render(100).map(stripAnsi).join("\n");
	assert.match(lines, /Apply_patch  config\/comet-state.yaml · 57ms/);
});
