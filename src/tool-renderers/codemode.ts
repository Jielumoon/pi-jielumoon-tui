/** Codemode 默认只展示全部子调用树；脚本与执行输出留给 Ctrl+O。 */
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { asPlainRecord, asRecord } from "../guards.ts";
import { reuseOrCreateWidthAware } from "./components.ts";
import { parseCodemodeArgs, previewCodemodeCalls } from "./codemode-preview.ts";
import { renderToolHeader, toolSubject } from "./header.ts";
import {
	displayText, resolvePresentation, styleText, wrapWithHangingIndent,
	type RenderPresentation, type ThemeLike,
} from "./presentation.ts";
import { textOf } from "./results.ts";
import type { RenderContextLike, RenderOptionsLike, ToolPhase, ToolResultLike } from "./types.ts";

const SCRIPT_HEADER = /^Script (?:completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

function scriptLines(args: unknown, presentation: RenderPresentation): string[] {
	const code = asRecord(args)?.code;
	return typeof code === "string" && code.length > 0
		? ["", styleText(presentation, "dim", "脚本："), ...displayText(code, presentation).split("\n")
			.map((line) => styleText(presentation, "toolOutput", line))]
		: [];
}

export function renderCodemodeCall(args: unknown, theme: ThemeLike | undefined, context: RenderContextLike): Component {
	const state = asRecord(context.state);
	if (context.isPartial === false || state?.codemodeHasResult) {
		return reuseOrCreateWidthAware(context.lastComponent, () => []);
	}
	const presentation = resolvePresentation(theme);
	const code = asRecord(args)?.code;
	// 首次真实记录到来前保留预览，不在 executionStarted 时先清空再重画。
	const calls = typeof code === "string" ? previewCodemodeCalls(code) : [];
	if (state) state.codemodePreview = calls;
	const header = renderToolHeader("codemode", args, presentation, context, {
		phase: "running",
		meta: calls.length > 0 ? [`${calls.length} 项预览`] : [],
	});
	const body = context.expanded ? scriptLines(args, presentation) : [];
	// 宿主先组装 call 再组装 result：延迟读共享 state，让首次 onUpdate 也只有一个标题。
	return reuseOrCreateWidthAware(context.lastComponent, (width) =>
		context.isPartial === false || state?.codemodeHasResult
			? [] : [header, ...callTree(calls, presentation, context, Boolean(context.expanded), width),
				...body.flatMap((line) => wrapWithHangingIndent("", line, width))]);
}

function callTree(calls: Record<string, unknown>[], presentation: RenderPresentation, context: RenderContextLike, expanded: boolean, width: number): string[] {
	return calls.flatMap((call, index) => {
		const name = displayText(call.name as string, presentation).replace(/\s+/g, " ");
		const renderName = name === "ffgrep" ? "grep" : name === "fffind" ? "find" : name;
		const rawArgs = typeof call.args === "string" ? call.args : "";
		const args = parseCodemodeArgs(rawArgs);
		const phase: ToolPhase = call.status === "running" || call.status === "preview" ? "running"
			: call.status === "error" || call.status === "cancelled" ? "error" : "success";
		const subject = toolSubject(renderName, args, presentation, context, phase, Infinity);
		if (!args || !subject.target) {
			subject.target = styleText(presentation, "muted", displayText(rawArgs, presentation).replace(/\s+/g, " "));
		}
		const ms = call.durationMs;
		const cost = call.cost;
		const meta = [
			...(typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? [ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`] : []),
			...(typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? [`$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`] : []),
			...(call.status === "cancelled" ? ["cancelled"] : []),
		];
		const header = renderToolHeader(name, args, presentation, context, { phase, subject, meta });
		const last = index === calls.length - 1;
		const prefix = styleText(presentation, "dim", presentation.mode === "screen-reader" ? "  " : `     ${last ? "╰" : "├"}─→ `);
		const continuation = styleText(presentation, "dim", presentation.mode === "screen-reader" ? "  " : `     ${last ? " " : "│"}   `);
		const lines = wrapWithHangingIndent(prefix, header, width).map((line, row) => row === 0 || presentation.mode === "screen-reader"
			? line : continuation + line.slice(visibleWidth(prefix)));
		const error = expanded && typeof call.error === "string" ? displayText(call.error, presentation) : "";
		return [...lines, ...error.split("\n").filter(Boolean).flatMap((line) =>
			wrapWithHangingIndent(continuation, styleText(presentation, "error", line), width))];
	});
}

export function renderCodemodeResult(
	result: ToolResultLike,
	options: RenderOptionsLike,
	theme: ThemeLike | undefined,
	context: RenderContextLike,
): Component {
	const state = asRecord(context.state);
	if (state) state.codemodeHasResult = true;
	const presentation = resolvePresentation(theme);
	const details = asPlainRecord(result.details);
	const calls = Array.isArray(details?.calls) ? details.calls.flatMap((value) => {
		const call = asPlainRecord(value);
		return call && typeof call.name === "string" ? [call] : [];
	}) : [];
	const partial = Boolean(options.isPartial || context.isPartial);
	const previews: Record<string, unknown>[] = partial && Array.isArray(state?.codemodePreview)
		? [...state.codemodePreview] : [];
	for (const call of calls) {
		// ponytail: 优先同名同参数；动态或截断参数仅按同名接替，准确映射需宿主提供源码位置。
		const exact = previews.findIndex((preview) => preview.name === call.name && preview.args === call.args);
		const index = exact >= 0 ? exact : previews.findIndex((preview) => preview.name === call.name);
		if (index >= 0) previews.splice(index, 1);
	}
	if (!partial && state) delete state.codemodePreview;
	const failed = Boolean(context.isError || result.isError);
	const expanded = options.expanded ?? context.expanded ?? false;
	const content = result.content ?? [];
	const output = (expanded || failed) && !partial
		? textOf({ content: SCRIPT_HEADER.test(content[0]?.text ?? "") ? content.slice(1) : content }, presentation).trim()
		: "";
	const errorBlock = failed ? [...content].reverse().find((item) => item.type === "text" && item.text?.startsWith("Script error:\n")) : undefined;
	const errorOutput = errorBlock ? textOf({ content: [errorBlock] }, presentation) : output;
	const error = failed ? errorOutput.split("\n").find((line) => line.trim() && line.trim() !== "Script error:") : undefined;
	const header = renderToolHeader("codemode", context.args, presentation, context, {
		phase: partial ? "running" : failed ? "error" : "success",
		meta: [`${calls.length} 次调用`, ...(previews.length > 0 ? [`${previews.length} 项预览`] : []),
			...(error && !expanded ? [truncateToWidth(error, 70, "…")] : [])],
		expandable: !expanded,
	});
	const body = expanded ? [
		...scriptLines(context.args, presentation),
		...(output ? ["", styleText(presentation, "dim", "输出："), ...output.split("\n")
			.map((line) => styleText(presentation, failed ? "error" : "toolOutput", line))] : []),
		...(typeof details?.fullOutputPath === "string"
			? [styleText(presentation, "dim", `完整输出：${displayText(details.fullOutputPath, presentation)}`)] : []),
	] : [];
	return reuseOrCreateWidthAware(context.lastComponent, (width) => [
		header,
		...callTree([...calls, ...previews], presentation, context, expanded, width),
		...body.flatMap((line) => wrapWithHangingIndent("", line, width)),
	]);
}
