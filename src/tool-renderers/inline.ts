/**
 * 一行式工具描述表：只给模型看的外设工具（MCP、抓取、检索、上下文杂务、提问）
 * 折叠态和 `read` 一样只留一行 canonical header，正文只在 Ctrl+O 展开时出现。
 * 这里只产内容；两列缩进、状态标记由 message-borders 统一处理。
 * 外部文本（参数、结果、details）一律经 displayText / renderToolHeader 净化后再着色。
 */

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { asPlainRecord } from "../guards.ts";
import { reuseOrCreateText, reuseOrCreateWidthAware } from "./components.ts";
import { renderToolHeader, type ToolSubject } from "./header.ts";
import {
	displayText,
	resolvePresentation,
	styleText,
	wrapWithHangingIndent,
	type RenderPresentation,
	type ThemeLike,
} from "./presentation.ts";
import { isExpanded, renderToolError, textOf } from "./results.ts";
import type { RenderContextLike, RenderOptionsLike, ToolResultLike } from "./types.ts";

type Args = Record<string, unknown>;
type Details = Record<string, unknown>;

type InlineSubject = {
	/** 动作词（describe / drop …），弱化显示。 */
	verb?: string;
	/** 主体：id 为标识符/路径/URL，query 加引号高亮，text 为自然语言。 */
	target?: { text: string; kind: "id" | "query" | "text" };
};

type InlineSpec = {
	label: string;
	/** 标签的主题色名，见 LABEL_COLORS。 */
	color: string;
	subject: (args: Args, details: Details | undefined, name: string) => InlineSubject;
	/** 结果徽章；缺省按正文推断（短单行原样、多行计数）。 */
	meta?: (text: string, details: Details | undefined, args: Args) => string[];
	/** 结果之外的失败信号：MCP 适配器用 details.error 表达失败但不置 isError。 */
	failed?: (details: Details | undefined) => boolean;
	/** 展开态在结果前附带的调用输入（弱化显示）。 */
	input?: (args: Args, name: string) => string;
	/** 展开态正文；缺省为结果文本（JSON 美化）。 */
	output?: (text: string, details: Details | undefined, args: Args) => string;
};

const SUMMARY_WIDTH = 60;
const SUBJECT_WIDTH = 72;
const SCRIPT_NAMES = 4;
const JSON_PRETTY_LIMIT = 200_000;
const NAMESPACE_PREFIX = "mcp__";

/**
 * 标签按工具类别着色，用主题色名而非固定 RGB：切主题（含亮色主题）仍可读。
 * 本地文件/代码类保持 toolTitle，Skill 用 mdHeading（见 header.ts）；上下文杂务用 muted 压低存在感。
 * 选色已核对 catppuccin-mocha 与 sakura-macaron 两套主题互不撞色。
 */
const LABEL_COLORS = {
	mcp: "syntaxNumber",
	web: "syntaxString",
	ask: "warning",
	context: "muted",
} as const;

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** 压成单行并按显示宽度截断（CJK 双宽、emoji 代理对都不会被劈开）。 */
function clip(text: string, width: number): string {
	return truncateToWidth(text.replace(/\s+/g, " ").trim(), width, "…");
}

function records(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		const record = asPlainRecord(item);
		return record ? [record] : [];
	});
}

function plural(count: number, unit: string, many = `${unit}s`): string {
	return `${count} ${count === 1 ? unit : many}`;
}

function formatSize(bytes: number): string {
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function jsonInput(value: unknown): string {
	if (value === undefined || (typeof value === "object" && value !== null && Object.keys(value).length === 0)) return "";
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** 缺省徽章：空正文 `empty`；短单行本身就是状态，原样展示；长单行或 JSON 报体积；多行计数。 */
function defaultMeta(text: string): string[] {
	const trimmed = text.trim();
	if (trimmed.length === 0) return ["empty"];
	const lines = trimmed.split("\n");
	if (lines.length > 1) return [plural(lines.length, "line")];
	const isStatus = trimmed.length <= SUMMARY_WIDTH && !/^[[{]/.test(trimmed);
	return [isStatus ? trimmed : formatSize(Buffer.byteLength(trimmed))];
}

function query(args: Args): InlineSubject {
	const value = str(args.query);
	return value ? { target: { text: clip(value, SUBJECT_WIDTH), kind: "query" } } : {};
}

function url(args: Args): InlineSubject {
	return str(args.url) ? { target: { text: shortenUrl(str(args.url)), kind: "id" } } : {};
}

function verbOnly(verb: string): InlineSubject {
	return verb ? { verb } : {};
}

// ─── MCP ────────────────────────────────────────────────────────

const MCP_VERBS = ["describe", "instructions", "connect", "search"] as const;

/**
 * `mcp` 网关与 `mcp__<server>` 命名空间代理都用 `{ tool, args }` 调用；
 * toolPrefix=mcp 时的直连工具 `mcp__<server>_<tool>` 则直接收 MCP 原始参数，只能按工具名展示。
 */
function isDirectTool(args: Args, name: string): boolean {
	return name.startsWith(NAMESPACE_PREFIX) && !str(args.tool);
}

function mcpSubject(args: Args, _details: Details | undefined, name: string): InlineSubject {
	if (isDirectTool(args, name)) return { target: { text: name.slice(NAMESPACE_PREFIX.length), kind: "id" } };
	const tool = str(args.tool);
	if (tool) return { target: { text: tool, kind: "id" } };
	for (const verb of MCP_VERBS) {
		const value = str(args[verb]);
		if (value) return { verb, target: { text: value, kind: verb === "search" ? "query" : "id" } };
	}
	const action = str(args.action);
	if (action) {
		const target = str(args.server) || str(args.url);
		return { verb: action, target: target ? { text: target, kind: "id" } : undefined };
	}
	const server = str(args.server);
	return server ? { verb: "list", target: { text: server, kind: "id" } } : { verb: "status" };
}

function mcpMeta(text: string, details: Details | undefined): string[] {
	const mode = str(details?.mode);
	if (mode === "status" && Array.isArray(details?.servers)) {
		return [`${Number(details.connectedCount ?? 0)}/${details.servers.length} servers`, plural(Number(details.totalTools ?? 0), "tool")];
	}
	if (mode === "search") {
		const count = typeof details?.count === "number" ? details.count : records(details?.matches).length;
		return [count === 0 ? "no matches" : plural(count, "tool")];
	}
	if (mode === "list" && Array.isArray(details?.tools) && !details?.error) return [plural(details.tools.length, "tool")];
	const summary = str(asPlainRecord(asPlainRecord(details?.mcpResult)?.structuredContent)?.summary);
	return summary ? [clip(summary, SUMMARY_WIDTH)] : defaultMeta(text);
}

const MCP_SPEC: InlineSpec = {
	label: "MCP",
	color: LABEL_COLORS.mcp,
	subject: mcpSubject,
	meta: mcpMeta,
	failed: (details) => Boolean(details?.error),
	input: (args, name) => jsonInput(isDirectTool(args, name) ? args : args.args),
};

/** 只按实际调用记录汇总：首次出现顺序，重复计数，超出上限记 `+N`。 */
function scriptSubject(_args: Args, details: Details | undefined): InlineSubject {
	const counts = new Map<string, number>();
	for (const call of records(details?.calls)) {
		const kind = str(call.operation);
		const name = kind === "call" ? str(call.path) : kind === "describe" ? `describe ${str(call.path)}` : "";
		if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	if (counts.size === 0) return {};
	const names = [...counts].map(([name, count]) => (count > 1 ? `${name}×${count}` : name));
	const shown = names.slice(0, SCRIPT_NAMES);
	if (names.length > SCRIPT_NAMES) shown.push(`+${names.length - SCRIPT_NAMES}`);
	return { target: { text: shown.join(", "), kind: "id" } };
}

const MCP_SCRIPT_SPEC: InlineSpec = {
	label: "MCP Script",
	color: LABEL_COLORS.mcp,
	subject: scriptSubject,
	meta: (text, details) => {
		const failed = records(details?.calls).filter((call) => call.ok === false).length;
		return [...(failed > 0 ? [`${failed} failed`] : []), ...defaultMeta(text)];
	},
	failed: (details) => Boolean(details?.error),
	input: (args) => str(args.code),
};

// ─── 抓取 / 检索 / 上下文 / 提问 ─────────────────────────────────

function shortenUrl(url: string): string {
	return clip(url.replace(/^https?:\/\/(?:www\.)?/, "").replace(/[?#].*$/, ""), SUBJECT_WIDTH);
}

/** compact 搜索常把引用内联在答案里而不回传来源列表；0 个来源时改报正文行数，免得像没搜到。 */
function sourcesMeta(text: string, details: Details | undefined): string[] {
	const count = details?.returned_sources_count ?? details?.sources_count;
	return typeof count === "number" && count > 0 ? [plural(count, "source")] : defaultMeta(text);
}

/** 单选/自定义答案在 answer，多选在 selected（answer 为 null）。 */
function answerText(answer: Record<string, unknown> | undefined): string {
	const selected = Array.isArray(answer?.selected) ? answer.selected.filter((item) => typeof item === "string") : [];
	return str(answer?.answer) || selected.join(", ");
}

// ─── pi-smart-search ────────────────────────────────────────────

/**
 * smart_search_* 的 details 只有 elapsedMs / fullOutputPath，数量只能从 pi-smart-search
 * format.ts 固定的摘要行取；取不到（格式变了、被截断）时退回缺省徽章。
 * 超过 12KB 截断落盘时补 `truncated`。
 */
function smartMeta(count: (text: string) => string[]): NonNullable<InlineSpec["meta"]> {
	return (text, details) => {
		const badges = count(text);
		return [...(badges.length > 0 ? badges : defaultMeta(text)), ...(str(details?.fullOutputPath) ? ["truncated"] : [])];
	};
}

function counted(pattern: RegExp, unit: string, many?: string): (text: string) => string[] {
	return (text) => {
		const match = pattern.exec(text);
		return match ? [plural(Number(match[1]), unit, many)] : [];
	};
}

/** 回答正文里也可能出现 `Sources:`，只数最后一段来源列表。 */
function smartSources(text: string): string[] {
	const marker = "\n\nSources:\n";
	const start = text.lastIndexOf(marker);
	if (start < 0) return [];
	const block = text.slice(start + marker.length).split("\n\n", 1)[0] ?? "";
	const count = block.split("\n").filter((line) => /^\[\d+\]/.test(line)).length;
	return count > 0 ? [plural(count, "source")] : [];
}

function smartProviders(text: string): string[] {
	const providers = text.split("\n").filter((line) => /^- \S+: /.test(line));
	const cooling = providers.filter((line) => /, cooldown \d+s/.test(line)).length;
	if (providers.length === 0) return [];
	return [plural(providers.length, "provider"), ...(cooling > 0 ? [`${cooling} in cooldown`] : [])];
}

const SMART_SEARCH_SPECS: [string, InlineSpec][] = [
	["smart_search_search", { label: "Search", color: LABEL_COLORS.web, subject: query, meta: smartMeta(smartSources) }],
	["smart_search_fetch", {
		label: "Fetch",
		color: LABEL_COLORS.web,
		subject: url,
		meta: smartMeta((text) => {
			const size = /\((\d+(?:\.\d+)?[KMG]?B)\)$/.exec(text.split("\n", 1)[0] ?? "")?.[1];
			return size ? [size] : [];
		}),
	}],
	["smart_search_research", {
		label: "Research",
		color: LABEL_COLORS.web,
		subject: query,
		meta: smartMeta(counted(/^(\d+) evidence item\(s\);/m, "evidence", "evidence")),
	}],
	["smart_search_exa_search", {
		label: "Exa",
		color: LABEL_COLORS.web,
		subject: query,
		meta: smartMeta(counted(/^Exa returned (\d+) result/, "result")),
	}],
	["smart_search_exa_similar", {
		label: "Exa",
		color: LABEL_COLORS.web,
		subject: (args) => ({ verb: "similar", ...url(args) }),
		meta: smartMeta(counted(/^Exa returned (\d+) result/, "result")),
	}],
	["smart_search_map", {
		label: "Map",
		color: LABEL_COLORS.web,
		subject: url,
		meta: smartMeta(counted(/^Site map for .* \((\d+) URL\(s\)\):/, "URL")),
	}],
	["smart_search_context7_library", {
		label: "Context7",
		color: LABEL_COLORS.web,
		subject: (args) => (str(args.name) ? { target: { text: clip(str(args.name), SUBJECT_WIDTH), kind: "id" } } : {}),
		meta: smartMeta(counted(/^Context7 returned (\d+) librar/, "library", "libraries")),
	}],
	["smart_search_context7_docs", {
		label: "Context7",
		color: LABEL_COLORS.web,
		// 库 id 弱化在前、查询高亮在后：同一个库查不同主题时仍能区分。
		subject: (args) => {
			const library = clip(str(args.library_id), SUBJECT_WIDTH);
			const topic = query(args);
			if (topic.target) return library ? { verb: library, ...topic } : topic;
			return library ? { target: { text: library, kind: "id" } } : {};
		},
		meta: smartMeta(() => []),
	}],
	["smart_search_plan", { label: "Plan", color: LABEL_COLORS.web, subject: query, meta: smartMeta(() => []) }],
	["smart_search_route", { label: "Route", color: LABEL_COLORS.web, subject: query, meta: smartMeta(() => []) }],
	["smart_search_doctor", {
		label: "Doctor",
		color: LABEL_COLORS.web,
		subject: () => ({}),
		// config_status 形如 `ok: configuration complete` / `config_error: …`，只取状态词。
		meta: smartMeta((text) => {
			const status = /"config_status":\s*"([a-z_]+)/.exec(text)?.[1];
			return status ? [status] : [];
		}),
	}],
	["smart_search_providers", {
		label: "Providers",
		color: LABEL_COLORS.web,
		subject: () => ({}),
		meta: smartMeta(smartProviders),
	}],
	["smart_search_tools", {
		label: "Search Tools",
		color: LABEL_COLORS.web,
		subject: (args) => {
			const groups = Array.isArray(args.groups) ? args.groups.filter((group) => typeof group === "string") : [];
			return groups.length > 0 ? { verb: "enable", target: { text: groups.join(", "), kind: "id" } } : verbOnly("enable");
		},
		meta: (text, details) => {
			if (!Array.isArray(details?.added)) return defaultMeta(text);
			const unavailable = Array.isArray(details.unavailable) ? details.unavailable.length : 0;
			return [
				details.added.length > 0 ? plural(details.added.length, "tool") : "no new tools",
				...(unavailable > 0 ? [`${unavailable} unavailable`] : []),
			];
		},
	}],
];

const INLINE_SPECS = new Map<string, InlineSpec>([
	["mcp", MCP_SPEC],
	["mcpScript", MCP_SCRIPT_SPEC],
	["web_fetch", {
		label: "Fetch",
		color: LABEL_COLORS.web,
		subject: url,
		meta: (text, details) => {
			const shown = details?.outputLines;
			const total = details?.totalLines;
			if (typeof shown !== "number") return defaultMeta(text);
			return [typeof total === "number" && total > shown ? `${shown}/${total} lines` : plural(shown, "line")];
		},
	}],
	["search", { label: "Search", color: LABEL_COLORS.web, subject: query, meta: sourcesMeta }],
	["docs_search", { label: "Docs", color: LABEL_COLORS.web, subject: query, meta: sourcesMeta }],
	["ctx_search", { label: "Ctx Search", color: LABEL_COLORS.context, subject: query }],
	["ctx_memory", { label: "Ctx Memory", color: LABEL_COLORS.context, subject: (args) => verbOnly(str(args.action)) }],
	["ctx_memory_list", { label: "Ctx Memory", color: LABEL_COLORS.context, subject: () => verbOnly("list") }],
	["ctx_note", {
		label: "Ctx Note",
		color: LABEL_COLORS.context,
		// 与 magic-context 一致：缺省 action 时有 content 即 write，否则 read。
		subject: (args) => verbOnly(str(args.action) || (str(args.content).trim() ? "write" : "read")),
	}],
	["ctx_reduce", {
		label: "Ctx Reduce",
		color: LABEL_COLORS.context,
		subject: (args) => (str(args.drop) ? { verb: "drop", target: { text: clip(str(args.drop), SUBJECT_WIDTH), kind: "id" } } : {}),
		meta: () => [],
	}],
	["ctx_expand", {
		label: "Ctx Expand",
		color: LABEL_COLORS.context,
		subject: (args) => {
			const range = args.message ?? (args.start === undefined ? undefined : `${String(args.start)}-${String(args.end ?? args.start)}`);
			return range === undefined ? {} : { target: { text: `§${String(range)}`, kind: "id" } };
		},
	}],
	["obs_recall", {
		label: "Recall",
		color: LABEL_COLORS.context,
		subject: (args) => (str(args.id) ? { target: { text: str(args.id), kind: "id" } } : {}),
		meta: (text, details) => [
			...(typeof details?.lines === "number" && details.lines > 1
				? [plural(details.lines, "line")]
				: typeof details?.bytes === "number" ? [formatSize(details.bytes)] : defaultMeta(text)),
			...(details?.eof === false ? ["more"] : []),
		],
	}],
	["ask_user_question", {
		label: "Ask",
		color: LABEL_COLORS.ask,
		subject: (args) => {
			const first = records(args.questions)[0];
			const question = str(first?.question) || str(first?.header);
			return question ? { target: { text: clip(question, SUBJECT_WIDTH), kind: "text" } } : {};
		},
		meta: (_text, details, args) => {
			if (details?.cancelled === true) return ["cancelled"];
			const answers = records(details?.answers);
			const extra = Math.max(answers.length, records(args.questions).length) - 1;
			return answers.length === 0 ? [] : [clip(answerText(answers[0]), SUMMARY_WIDTH), ...(extra > 0 ? [`+${extra}`] : [])];
		},
		output: (text, details) => {
			const answers = records(details?.answers);
			return answers.length === 0
				? text
				: answers.map((answer) => `${str(answer.question)}\n→ ${answerText(answer)}`).join("\n\n");
		},
	}],
	...SMART_SEARCH_SPECS,
]);

function specFor(name: string): InlineSpec | undefined {
	return name.startsWith(NAMESPACE_PREFIX) ? MCP_SPEC : INLINE_SPECS.get(name);
}

/** 描述表接管的工具名（read 另有专门 renderer）。 */
export function isInlineSpecTool(name: string | undefined): boolean {
	return name !== undefined && specFor(name) !== undefined;
}

/** 不画外框的工具：read、Codemode 调用树与描述表内的全部工具。 */
export function isInlineTool(name: string | undefined): boolean {
	return name === "read" || name === "codemode" || isInlineSpecTool(name);
}

/** 结构化失败信号（isError 之外），供外框层决定 × 与失败底色。 */
export function isInlineToolFailed(name: string | undefined, details: unknown): boolean {
	const spec = name === undefined ? undefined : specFor(name);
	return spec?.failed?.(asPlainRecord(details)) === true;
}

// ─── 渲染 ───────────────────────────────────────────────────────

function renderSubject(spec: InlineSpec, subject: InlineSubject, presentation: RenderPresentation): ToolSubject {
	const target = subject.target;
	const text = target ? displayText(target.text, presentation) : "";
	const styled = !target
		? ""
		: target.kind === "query"
			// 查询本身带引号（精确短语搜索）时不再套一层，避免 `""phrase"`。
			? styleText(presentation, "accent", text.includes("\"") ? text : `"${text}"`)
			: styleText(presentation, target.kind === "text" ? "toolOutput" : "syntaxType", text);
	const verb = subject.verb ? styleText(presentation, "dim", displayText(subject.verb, presentation)) : "";
	return { label: spec.label, labelColor: spec.color, target: [verb, styled].filter(Boolean).join(" "), meta: [] };
}

function prettyOutput(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length > JSON_PRETTY_LIMIT || !/^[[{]/.test(trimmed)) return trimmed;
	try {
		return JSON.stringify(JSON.parse(trimmed), null, 2);
	} catch {
		// 非 JSON 或被截断：原样展示。
		return trimmed;
	}
}

export function renderInlineToolCall(
	name: string,
	args: unknown,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const spec = specFor(name);
	if (!spec || context.isPartial === false) return reuseOrCreateText(context.lastComponent, "");
	const presentation = resolvePresentation(theme);
	const header = renderToolHeader(name, args, presentation, context, {
		phase: "running",
		subject: renderSubject(spec, spec.subject(asPlainRecord(args) ?? {}, undefined, name), presentation),
	});
	// 一行式标题超宽时截断而不是换行（Text 会把长标题折成多行）。
	return reuseOrCreateWidthAware(context.lastComponent, () => [header]);
}

export function renderInlineToolResult(
	name: string,
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const spec = specFor(name);
	if (!spec || context.isPartial || options.isPartial) return reuseOrCreateText(context.lastComponent, "");
	const presentation = resolvePresentation(theme);
	const args = asPlainRecord(context.args) ?? {};
	const details = asPlainRecord(result.details);
	const text = textOf(result, presentation);
	const subject = renderSubject(spec, spec.subject(args, details, name), presentation);
	if (context.isError || result.isError || spec.failed?.(details)) {
		return renderToolError(name, text || `${spec.label} failed`, options, presentation, context, [], 0, subject);
	}

	const raw = text.trim();
	// 纯图片结果（MCP 截图）由宿主在标题下方直接画图，徽章报张数而不是 empty。
	const images = result.content?.filter((item) => item?.type === "image").length ?? 0;
	const meta = raw.length === 0 && images > 0
		? [plural(images, "image")]
		: (spec.meta ?? defaultMeta)(text, details, args);
	const input = spec.input?.(args, name) ?? "";
	// 徽章已经完整复述了正文（短单行）时不再提示展开；但窄屏下标题会被截断，
	// 所以显式展开时只要有正文就照常铺开，不能被这里的去重挡住。
	const hasBody = input.length > 0 || raw.length > 0;
	const hasMore = input.length > 0 || (raw.length > 0 && !(meta.length === 1 && meta[0] === raw));
	const expanded = isExpanded(options, context);
	const header = renderToolHeader(name, args, presentation, context, {
		phase: "success",
		meta,
		expandable: hasMore && !expanded,
		subject,
	});
	if (!expanded || !hasBody) return reuseOrCreateWidthAware(context.lastComponent, () => [header]);

	// JSON 美化只在展开时做：Ctrl+O 会让全部工具组件重建，折叠态不应反复解析大结果。
	const output = spec.output ? spec.output(text, details, args) : prettyOutput(text);
	const prefix = presentation.mode === "screen-reader" ? "output: " : "";
	const section = (value: string, color: string): string[] => value.length === 0
		? []
		: displayText(value, presentation).split("\n").map((line) => styleText(presentation, color, line));
	const lines = [...section(input, "muted"), ...(input && output ? [""] : []), ...section(output, "toolOutput")];
	return reuseOrCreateWidthAware(context.lastComponent, (width) => [
		header,
		...lines.flatMap((line) => wrapWithHangingIndent(prefix, line, width)),
	]);
}
