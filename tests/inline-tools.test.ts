import assert from "node:assert/strict";
import test from "node:test";
import {
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	initTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../src/ansi.ts";
import { installMessageBorders } from "../src/message-borders.ts";
import installReadmapRenderers, { isInlineTool } from "../src/readmap-renderers/index.ts";
import { renderInlineToolResult } from "../src/readmap-renderers/inline.ts";
import { renderFindResult, renderGrepResult, renderReadResult } from "../src/readmap-renderers/results.ts";

// 测试基线固定为 color 模式：宿主终端的 NO_COLOR/TERM 不得改变断言结果。
process.env.PI_READMAP_RENDER_MODE = "color";
delete process.env.NO_COLOR;
initTheme("dark");

installReadmapRenderers({
	events: { on: () => {} },
	registerTool: () => {},
	on: () => {},
} as unknown as ExtensionAPI);

type Result = { content: Array<{ type: string; text: string }>; details?: unknown; isError: boolean };

function tool(name: string): Record<string, unknown> {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: { type: "object" },
		execute: () => ({ content: [] }),
		renderCall: () => ({ render: () => ["third-party call"], invalidate() {} }),
		renderResult: () => ({ render: () => ["third-party result"], invalidate() {} }),
	};
}

function component(name: string, args: Record<string, unknown>): ToolExecutionComponent {
	return new ToolExecutionComponent(name, `${name}-call`, args, {}, tool(name) as never, { requestRender() {} } as never, "/tmp");
}

function textResult(text: string, details?: unknown, isError = false): Result {
	return { content: [{ type: "text", text }], details, isError };
}

/** 宿主 Text 会把行尾补齐到整宽；断言只看可见内容。 */
function plain(lines: readonly string[]): string {
	return lines.map((line) => stripAnsi(line).trimEnd()).join("\n");
}

function contentLines(lines: readonly string[]): string[] {
	return lines.map((line) => stripAnsi(line).trimEnd()).filter((line) => line.length > 0);
}

function withBorders(run: () => void): void {
	const cleanup = installMessageBorders(() => undefined, { toolBackground: true });
	try {
		run();
	} finally {
		cleanup();
	}
}

test("一行式工具名单：read、描述表工具与 mcp__ 命名空间；普通工具仍画框", () => {
	for (const name of ["read", "mcp", "mcpScript", "mcp__js_reverse", "web_fetch", "search", "ask_user_question", "obs_recall"]) {
		assert.equal(isInlineTool(name), true, name);
	}
	for (const name of ["bash", "edit", "todowrite", "spawn_scouts", "nu", undefined]) {
		assert.equal(isInlineTool(name), false, String(name));
	}
});

test("MCP 调用折叠只剩一行，不泄露参数与原始 JSON；展开无框显示输入和美化结果", () => {
	withBorders(() => {
		const call = component("mcp", { tool: "director-desk_director_read", args: { ids: ["private-scene-id"] } });
		const running = contentLines(call.render(100));
		assert.equal(running.length, 1);
		assert.match(running[0]!, /^ {2}\S MCP {2}director-desk_director_read$/);

		call.updateResult(textResult('{"ok":true,"data":{"revision":123}}', { mode: "call" }));
		for (const width of [12, 40, 100]) {
			const lines = call.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
			assert.equal(contentLines(lines).length, 1, `折叠态必须只有一行（${width} 列）`);
			assert.doesNotMatch(plain(lines), /private-scene-id|revision|[╭╰┃]/);
		}
		assert.match(plain(call.render(100)), /^ {2}✓ MCP {2}director-desk_director_read · 35 B · Ctrl\+O$/m);

		call.setExpanded(true);
		const expanded = plain(call.render(100));
		assert.match(expanded, /private-scene-id/);
		assert.match(expanded, /^ {6}"revision": 123$/m, "结果 JSON 要美化，并在两列缩进下保留嵌套层级");
		assert.doesNotMatch(expanded, /[╭╰┃]/, "展开态同 read 一样不画框");
	});
});

test("MCP 用 details.error 表达的失败即使 isError=false 也显示 ×，并把原因放进标题", () => {
	withBorders(() => {
		const call = component("mcp", { instructions: "director-desk" });
		call.updateResult(textResult('Server "director-desk" does not provide instructions.', {
			mode: "instructions", server: "director-desk", error: "no_instructions",
		}));
		const lines = contentLines(call.render(120));
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /^ {2}× MCP {2}instructions director-desk · Server "director-desk" does not provide instructions\. · Ctrl\+O$/);
	});
});

test("MCP 状态、搜索与命名空间代理用结构化字段做徽章", () => {
	withBorders(() => {
		const status = component("mcp", {});
		status.updateResult(textResult("MCP: 1/2 servers\n\n⚠ warning", { mode: "status", servers: [{}, {}], connectedCount: 1, totalTools: 18 }));
		assert.match(plain(status.render(100)), /✓ MCP {2}status · 1\/2 servers · 18 tools · Ctrl\+O/);

		const search = component("mcp", { search: "director_apply" });
		search.updateResult(textResult('Found 3 tools matching "director_apply":\n- a\n- b\n- c', { mode: "search", count: 3 }));
		assert.match(plain(search.render(100)), /✓ MCP {2}search "director_apply" · 3 tools · Ctrl\+O/);

		const namespaced = component("mcp__js_reverse", { tool: "js-reverse_new_page", args: {} });
		namespaced.updateResult(textResult("# new_page response\n## Pages", {
			mode: "call", mcpResult: { structuredContent: { summary: "new_page completed" } },
		}));
		assert.match(plain(namespaced.render(100)), /✓ MCP {2}js-reverse_new_page · new_page completed · Ctrl\+O/);
	});
});

test("MCP Script 运行时不铺代码；完成按实际调用记录计数并标出失败数", () => {
	withBorders(() => {
		const code = `const value = "${"x".repeat(1600)}";\nemit(value);`;
		const script = component("mcpScript", { code });
		const running = plain(script.render(80));
		assert.match(running, /MCP Script/);
		assert.doesNotMatch(running, /const|emit|[╭┃]/);

		script.updateResult(textResult("scene saved\nrevision 124", {
			mode: "script",
			calls: [
				{ operation: "search", ok: true },
				{ operation: "call", path: "director_spatial", ok: true },
				{ operation: "call", path: "director_spatial", ok: true },
				{ operation: "call", path: "director_skill", ok: false },
			],
		}));
		const done = contentLines(script.render(120));
		assert.equal(done.length, 1);
		assert.match(done[0]!, /^ {2}✓ MCP Script {2}director_spatial×2, director_skill · 1 failed · 2 lines · Ctrl\+O$/);

		script.setExpanded(true);
		assert.match(plain(script.render(120)), /emit\(value\)/, "展开后可见完整脚本");
	});
});

test("抓取、检索、提问和召回都收成一行摘要", () => {
	withBorders(() => {
		const fetch = component("web_fetch", { url: "https://www.example.com/docs/page?x=1" });
		fetch.updateResult(textResult("a\nb\nc", { outputLines: 95, totalLines: 153, truncated: true }));
		assert.match(plain(fetch.render(100)), /^ {2}✓ Fetch {2}example\.com\/docs\/page · 95\/153 lines · Ctrl\+O$/m);

		const search = component("search", { query: '"exact phrase" docs' });
		search.updateResult(textResult("answer\nmore", { sources_count: 0, returned_sources_count: 0 }));
		assert.match(plain(search.render(100)), /✓ Search {2}"exact phrase" docs · 2 lines · Ctrl\+O/, "0 来源退回行数，自带引号不再加一层");

		const ask = component("ask_user_question", { questions: [{ question: "默认检索范围？" }, { question: "输出格式？" }] });
		ask.updateResult(textResult("User has answered", {
			answers: [
				{ questionIndex: 0, question: "默认检索范围？", answer: "逐级扩大" },
				{ questionIndex: 1, question: "输出格式？", answer: "行动卡片" },
			],
		}));
		assert.match(plain(ask.render(100)), /✓ Ask {2}默认检索范围？ · 逐级扩大 · \+1 · Ctrl\+O/);
		ask.setExpanded(true);
		assert.match(plain(ask.render(100)), /输出格式？\n {2}→ 行动卡片/);

		const recall = component("obs_recall", { id: "obs_1234" });
		recall.updateResult(textResult("{}", { lines: 1, bytes: 15_872, eof: false }));
		assert.match(plain(recall.render(100)), /✓ Recall {2}obs_1234 · 15\.5 KB · more · Ctrl\+O/);

		const memory = component("ctx_memory", { action: "write", content: "secret memory body" });
		memory.updateResult(textResult("Saved memory [ID: 477] in CONSTRAINTS."));
		const memoryText = plain(memory.render(100));
		assert.match(memoryText, /✓ Ctx Memory {2}write · Saved memory \[ID: 477\] in CONSTRAINTS\.$/m);
		assert.doesNotMatch(memoryText, /secret memory body|Ctrl\+O/, "短单行已完整展示时不提示展开");

		// 窄屏下标题截断了短结果：显式展开仍要给出全文，不能被“徽章=正文”的去重挡住。
		const narrow = contentLines(memory.render(40));
		assert.equal(narrow.length, 1);
		assert.doesNotMatch(narrow[0]!, /477/);
		memory.setExpanded(true);
		assert.match(plain(memory.render(40)), /^ {2}Saved memory \[ID: 477\]/m);
	});
});

test("pi-smart-search 的 smart_search_* 收成一行，数量取自摘要行，截断时标出", () => {
	const names = [
		"search", "fetch", "research", "exa_search", "exa_similar", "map", "context7_library",
		"context7_docs", "plan", "route", "doctor", "providers", "tools",
	].map((name) => `smart_search_${name}`);
	for (const name of names) assert.equal(isInlineTool(name), true, name);

	const header = (name: string, args: Record<string, unknown>, text: string, details?: unknown): string => {
		const call = component(`smart_search_${name}`, args);
		call.updateResult(textResult(text, details));
		const lines = contentLines(call.render(120));
		assert.equal(lines.length, 1, `${name} 折叠态必须只有一行`);
		return lines[0]!.trimStart();
	};
	withBorders(() => {
		// 回答正文里自带的 Sources: 不算，只数最后一段来源列表。
		const answer = "结论\n\nSources:\n[9] https://fake\n\n正文继续";
		assert.equal(
			header("search", { query: "node sqlite" }, `${answer}\n\nSources:\n[1] https://a\n[2] https://b\n\nSmart Search: xai (m), 28.8s`),
			'✓ Search  "node sqlite" · 2 sources · Ctrl+O',
		);
		assert.equal(
			header("search", { query: "q" }, "很长的回答\n被截断", { fullOutputPath: "/tmp/p/x.md" }),
			'✓ Search  "q" · 2 lines · truncated · Ctrl+O',
			"来源列表被截掉时退回行数",
		);
		assert.equal(
			header("fetch", { url: "https://raw.githubusercontent.com/a/b/extensions.md" }, "Fetched https://raw.githubusercontent.com/a/b/extensions.md via tavily (2.0KB)\n\n# Ext"),
			"✓ Fetch  raw.githubusercontent.com/a/b/extensions.md · 2.0KB · Ctrl+O",
		);
		assert.equal(
			header("research", { query: "进度回调" }, "Research: 进度回调\nbudget=quick, 21.1s, gap_check=closed\n5 evidence item(s); full page text is saved in /tmp/r\n\n[1] a"),
			'✓ Research  "进度回调" · 5 evidence · Ctrl+O',
		);
		assert.equal(
			header("exa_search", { query: "pi" }, "Exa returned 3 result(s) for: pi\n\n[1] a"),
			'✓ Exa  "pi" · 3 results · Ctrl+O',
		);
		assert.equal(
			header("exa_similar", { url: "https://github.com/earendil-works/pi" }, "Exa returned 1 result(s) similar to: https://github.com/earendil-works/pi\n\n[1] a"),
			"✓ Exa  similar github.com/earendil-works/pi · 1 result · Ctrl+O",
		);
		assert.equal(
			header("map", { url: "https://pi.dev/docs/latest" }, "Site map for https://pi.dev/docs/latest (10 URL(s)):\nhttps://pi.dev/docs/latest"),
			"✓ Map  pi.dev/docs/latest · 10 URLs · Ctrl+O",
		);
		assert.equal(
			header("context7_library", { name: "react" }, "Context7 returned 1 library for: react\n\n[1] /facebook/react — React"),
			"✓ Context7  react · 1 library · Ctrl+O",
		);
		assert.equal(
			header("context7_docs", { library_id: "/facebook/react", query: "hooks" }, "Context7 docs for /facebook/react (query: hooks)\n\nbody"),
			'✓ Context7  /facebook/react "hooks" · 3 lines · Ctrl+O',
		);
		assert.equal(
			header("doctor", {}, '{\n  "config_status": "config_error: Run `smart-search setup`"\n}'),
			"✓ Doctor · config_error · Ctrl+O",
		);
		assert.equal(
			header("providers", {}, "Provider health (cooldown 900s after 2 failures):\n- exa: closed, failures=0\n- tavily: open, failures=2, cooldown 120s"),
			"✓ Providers · 2 providers · 1 in cooldown · Ctrl+O",
		);
		assert.equal(
			header("tools", { groups: ["exa", "context7"] }, "Activated: a, b, c, d\n- exa: a, b\n- context7: c, d", { groups: ["exa", "context7"], added: ["a", "b", "c", "d"], unavailable: [] }),
			"✓ Search Tools  enable exa, context7 · 4 tools · Ctrl+O",
		);
	});
});

test("一行式工具运行中标题过长时截断主体，保留实时秒表", () => {
	const originalNow = Date.now;
	withBorders(() => {
		try {
			Date.now = () => 1_000;
			const call = component("web_fetch", { url: `https://example.com/${"very-long-segment/".repeat(10)}` });
			call.render(40);
			Date.now = () => 5_000;
			const lines = contentLines(call.render(40));
			assert.equal(lines.length, 1);
			assert.match(lines[0]!, /^ {2}\S Fetch {2}example\.com\/.*… · 4s$/);
			assert.ok(visibleWidth(lines[0]!) <= 40);
		} finally {
			Date.now = originalNow;
		}
	});
});

test("一行式标题与展开正文净化终端控制序列并守住宽度", () => {
	withBorders(() => {
		const call = component("mcp", { tool: "evil\u001b[2J\u001b]8;;https://x\u0007name" });
		call.updateResult(textResult(`line\u001b[31m red\u001b[0m\n${"很长".repeat(200)}`, { mode: "call" }));
		for (const expanded of [false, true]) {
			call.setExpanded(expanded);
			for (const width of [12, 40, 100]) {
				const lines = call.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
				assert.doesNotMatch(lines.join("\n"), /\u001b\[2J|\u001b\[31m|https:\/\/x/);
			}
		}
	});
});

test("标签按工具类别使用不同主题色，本地文件类保持 toolTitle", () => {
	const markTheme = { fg: (color: string, text: string) => `«${color}:${text}»`, bold: (text: string) => text };
	const header = (name: string, args: Record<string, unknown>): string =>
		renderInlineToolResult(name, textResult("a\nb"), {}, markTheme, { args }).render(200).join("\n");
	assert.match(header("mcp", { tool: "x" }), /«syntaxNumber:MCP»/);
	assert.match(header("mcpScript", { code: "1" }), /«syntaxNumber:MCP Script»/);
	assert.match(header("mcp__js_reverse", { tool: "x" }), /«syntaxNumber:MCP»/);
	assert.match(header("web_fetch", { url: "https://a.b" }), /«syntaxString:Fetch»/);
	assert.match(header("search", { query: "q" }), /«syntaxString:Search»/);
	assert.match(header("smart_search_research", { query: "q" }), /«syntaxString:Research»/);
	assert.match(header("ask_user_question", {}), /«warning:Ask»/);
	assert.match(header("ctx_reduce", { drop: "1" }), /«muted:Ctx Reduce»/);
	assert.match(header("obs_recall", { id: "o" }), /«muted:Recall»/);

	const read = (path: string): string =>
		renderReadResult(textResult("a"), {}, markTheme, { args: { path } }).render(200).join("\n");
	assert.match(read("skills/grilling/SKILL.md"), /«mdHeading:Skill»/);
	assert.match(read("src/index.ts"), /«toolTitle:Read»/);
});

test("完成后只剩标题的卡片收成一行，运行中仍保留外框", () => {
	type ToolPrototype = { render(this: unknown, width: number): string[] };
	const prototype = ToolExecutionComponent.prototype as unknown as ToolPrototype;
	const originalRender = prototype.render;
	let cleanup = (): void => {};
	try {
		let body = ["", "✓ Ls  /tmp · empty"];
		prototype.render = () => body;
		cleanup = installMessageBorders(() => undefined, { toolBackground: true });
		const settled = prototype.render.call({ isPartial: false, result: { isError: false, content: [] }, toolName: "ls" }, 80);
		assert.deepEqual(contentLines(settled), ["  ✓ Ls  /tmp · empty"]);

		// 第三方 default shell：Box 上下 padding 去底色后是整行空格，不能残留在一行式输出里。
		body = ["", "\x1b[48;5;236m" + " ".repeat(80) + "\x1b[49m", " ✓ todo  add item" + " ".repeat(60), " ".repeat(80)];
		const padded = prototype.render.call({ isPartial: false, result: { isError: false, content: [] }, toolName: "todo" }, 80);
		assert.deepEqual(padded.map((line) => stripAnsi(line).trimEnd()), ["", "  ✓ todo  add item"]);

		body = ["", "◇ Ls  /tmp"];
		const running = plain(prototype.render.call({ isPartial: true, result: undefined, toolName: "ls" }, 80));
		assert.match(running, /^╭─ \S Ls {2}\/tmp ─+╮/m, "运行态空卡片保持外框，避免完成前闪成一行");

		body = ["", "✓ Bash  echo hi · 1 line", "│ hi"];
		const withOutput = plain(prototype.render.call({ isPartial: false, result: { isError: false, content: [] }, toolName: "bash" }, 80));
		assert.match(withOutput, /^╭─ ✓ Bash/m, "有正文的卡片不受影响");

		// 工具已卸载或 patch 未生效时，宿主平铺参数与原始输出，必须仍有外框兜住。
		body = ["", "mcp__gone_tool", "", "{\"secret\": 1}", "raw output"];
		const unpatched = plain(prototype.render.call({ isPartial: false, result: { isError: false, content: [] }, toolName: "mcp__gone_tool" }, 80));
		assert.match(unpatched, /^╭─ /m);
		assert.match(unpatched, /^┃.*raw output/m);
	} finally {
		cleanup();
		prototype.render = originalRender;
	}
});

test("外部 details 文本进标题前净化：MCP summary 与提问答案不能注入终端序列", () => {
	withBorders(() => {
		const call = component("mcp", { tool: "js-reverse_new_page", args: {} });
		call.updateResult(textResult("# page\n## body", {
			mode: "call", mcpResult: { structuredContent: { summary: "done\u001b]52;c;ZXZpbA==\u0007\u001b[2J" } },
		}));
		const callLines = call.render(100).join("\n");
		assert.doesNotMatch(callLines, /\u001b\]52|\u001b\[2J/);
		assert.match(plain(call.render(100)), /✓ MCP {2}js-reverse_new_page · done · Ctrl\+O/);

		const ask = component("ask_user_question", { questions: [{ question: "Pick?" }] });
		ask.updateResult(textResult("answered", { answers: [{ questionIndex: 0, question: "Pick?", answer: "A\u001b]52;c;eA==\u0007" }] }));
		assert.doesNotMatch(ask.render(100).join("\n"), /\u001b\]52/);
	});
});

test("toolPrefix=mcp 的直连工具按工具名显示并在展开时给出原始参数", () => {
	withBorders(() => {
		const direct = component("mcp__fetch_fetch", { url: "https://example.com/a" });
		assert.match(plain(direct.render(100)), /^ {2}\S MCP {2}fetch_fetch$/m, "不能退化成 status");
		direct.updateResult(textResult("page text\nmore", { mode: "call" }));
		assert.match(plain(direct.render(100)), /✓ MCP {2}fetch_fetch · 2 lines · Ctrl\+O/);
		direct.setExpanded(true);
		assert.match(plain(direct.render(100)), /"url": "https:\/\/example\.com\/a"/);
	});
});

test("多选答案、纯图片结果、空 skill 与原型键工具名都不会显示假信息", () => {
	withBorders(() => {
		const ask = component("ask_user_question", { questions: [{ question: "Pick?", multiSelect: true }] });
		ask.updateResult(textResult("answered", { answers: [{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: ["A", "B"] }] }));
		assert.match(plain(ask.render(100)), /✓ Ask {2}Pick\? · A, B · Ctrl\+O/);
		ask.setExpanded(true);
		assert.match(plain(ask.render(100)), /→ A, B/);

		const shot = component("mcp", { tool: "js-reverse_take_screenshot", args: {} });
		shot.updateResult({ content: [{ type: "image", data: "", mimeType: "image/png" } as never], details: { mode: "call" }, isError: false });
		assert.match(plain(shot.render(100)), /✓ MCP {2}js-reverse_take_screenshot · 1 image$/m);

		const empty = new SkillInvocationMessageComponent({ name: "x", location: "/s/x/SKILL.md", content: "  ", userMessage: undefined });
		assert.deepEqual(contentLines(empty.render(80)), ["  ✓ Skill  x · empty"]);
	});
	for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
		assert.equal(isInlineTool(name), false, name);
	}
});

test("/skill 调用块和 read SKILL.md 都显示成一行 Skill", () => {
	withBorders(() => {
		const block = new SkillInvocationMessageComponent({
			name: "grilling",
			location: "/home/user/.pi/agent/skills/grilling/SKILL.md",
			content: "# Grilling\n\nAsk hard questions.\n\n- one\n- two",
			userMessage: undefined,
		});
		const collapsed = block.render(80);
		assert.deepEqual(contentLines(collapsed), ["  ✓ Skill  grilling · 6 lines · Ctrl+O"]);
		assert.doesNotMatch(collapsed.join("\n"), /\x1b\[48[;:]/, "不再带宿主 customMessageBg 底色");
		block.setExpanded(true);
		const expanded = plain(block.render(80));
		assert.match(expanded, /✓ Skill {2}grilling · 6 lines$/m);
		assert.match(expanded, /^ {2}Ask hard questions\.$/m);

		const read = component("read", { path: "/home/user/.pi/agent/skills/grilling/SKILL.md" });
		read.updateResult(textResult("a\nb\nc"));
		assert.match(plain(read.render(100)), /^ {2}✓ Skill {2}grilling · 3 lines · Ctrl\+O$/m, "整份 SKILL.md 省掉 1 ~ N");
		const partial = component("read", { path: "skills/grilling/SKILL.md", offset: 40, limit: 2 });
		partial.updateResult(textResult("x\ny"));
		assert.match(plain(partial.render(100)), /✓ Skill {2}grilling · 40 ~ 41 · 2\/41 lines/, "续读片段保留行范围");
		for (const path of ["./SKILL.md", "../SKILL.md", "SKILL.md"]) {
			const relative = component("read", { path });
			relative.updateResult(textResult("a"));
			assert.match(plain(relative.render(100)), /✓ Read {2}/, `${path} 没有可用的 skill 名，保持 Read`);
		}
	});
});

test("ffgrep / fffind 走 Grep / Find 渲染并兼容 fff 分组输出", () => {
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const body = [
		"tests/run_test.py  [modified in git]",
		" 156- ",
		" 157: def logout(runtime, session_id=None):",
		" 158- assert session_id",
		"",
		"root/daemon.py",
		" 122: def maintain_account(runtime):",
	].join("\n");
	const grep = renderGrepResult(textResult(body, { totalMatched: 2, totalFiles: 21 }), {}, theme, {
		args: { pattern: "logout|maintain_account", path: "" },
	}).render(120).join("\n");
	assert.match(grep, /^✓ Grep {2}\/logout\|maintain_account\/ in \. · 2 matches · 2 files$/m);
	assert.match(grep, /^tests\/run_test\.py$/m, "文件头去掉 [modified in git] 标记");
	assert.match(grep, /^ {2}157: def logout/m);
	assert.match(grep, /^ {2}158· assert session_id/m);
	assert.match(grep, /^root\/daemon\.py$/m);

	// fff 分页只在尾注给 cursor，details 没有截断标记。
	const paged = renderGrepResult(textResult(`${body}\n\n[Continue with cursor="fff_c1"]`, { totalMatched: 40, totalFiles: 21 }), {}, theme, {
		args: { pattern: "logout", path: "" },
	}).render(120).join("\n");
	assert.match(paged, /^✓ Grep .* · truncated · Ctrl\+O$/m);
	assert.doesNotMatch(paged, /cursor=/);

	const find = renderFindResult(textResult("web/.env.example  [modified in git]\nREADME.md  [often touched file]", {
		totalMatched: 771, totalFiles: 839, pageIndex: 0, hasMore: true,
	}), {}, theme, {
		args: { pattern: "env" },
	}).render(120).join("\n");
	assert.match(find, /✓ Find {2}env in \. · 2 results · truncated/);
	assert.doesNotMatch(find, /in git|touched file/);

	// 原生 find 没有 fff details：`  [draft]` 与形似 fff 的后缀都是合法文件名，必须原样保留。
	for (const expanded of [false, true]) {
		const native = renderFindResult(textResult("report  [draft]\nnotes  [modified in git]"), { expanded }, theme, {
			args: { pattern: "report" }, expanded,
		}).render(120).join("\n");
		assert.match(native, /report {2}\[draft\]/);
		assert.match(native, /notes {2}\[modified in git\]/);
	}

	withBorders(() => {
		const ffgrep = component("ffgrep", { pattern: "logout", path: "tests/" });
		ffgrep.updateResult(textResult(body));
		assert.match(plain(ffgrep.render(120)), /╭─ ✓ Grep {2}\/logout\/ in tests\//, "ffgrep 复用 Grep 卡片");
	});
});
