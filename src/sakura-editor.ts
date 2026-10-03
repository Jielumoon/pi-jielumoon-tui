import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { stripAnsi } from "./ansi.ts";
import { renderSakuraFrameGradient, renderSakuraFrameSegment, renderSakuraSolid } from "./gradient.ts";
import { renderModelLabel } from "./footer/render.ts";
import { DEFAULT_FOOTER_SETTINGS, getIcons, type FooterSettings } from "./footer/types.ts";

const FRAME_CHROME_WIDTH = 4;
const MIN_CONTENT_WIDTH = 3;
const MIN_FRAME_WIDTH = FRAME_CHROME_WIDTH + MIN_CONTENT_WIDTH;
const SCROLL_LABEL = /^─*\s*([↑↓]\s+\d+\s+more)\s*─*$/;

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** 宿主 StatusIndicator 暴露给边框的渲染接口。 */
type BorderStatus = {
	renderInBorder(width: number): string;
	renderSpinnerInBorder?(width: number): string;
};

function fitLine(line: string, width: number): string {
	const clipped = truncateToWidth(line, Math.max(0, width), "");
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

/** Pi Editor 唯一会在正文外输出的横线：顶部、底部和滚动提示。 */
function isEditorBorderLine(line: string): boolean {
	const plain = stripAnsi(line);
	return /^─+$/.test(plain) || /^─*\s*[↑↓]\s+\d+\s+more\s*─*$/.test(plain);
}

/**
 * Pi 会把 autocomplete 列表追加在底边之后；倒序定位底边以保证列表留在框外。
 * 匹配规则严格对应 Pi 0.83 Editor.render() 的横线与滚动提示格式。
 */
function findBottomBorderIndex(lines: readonly string[]): number {
	for (let index = lines.length - 1; index >= 1; index--) {
		if (isEditorBorderLine(lines[index] ?? "")) return index;
	}
	return Math.max(0, lines.length - 1);
}

function roundedBorder(width: number, edge: "top" | "bottom", sourceLine?: string, status?: BorderStatus,
	modelLabel?: (width: number) => string): string {
	if (width <= 0) return "";
	if (width === 1) return renderSakuraSolid(edge === "top" ? "╭" : "╰");

	const [leftCorner, rightCorner] = edge === "top" ? ["╭", "╮"] : ["╰", "╯"];
	const innerWidth = width - 2;
	const plainSource = sourceLine === undefined ? "" : stripAnsi(sourceLine);
	const scrollMatch = plainSource.match(SCROLL_LABEL);

	if (status || modelLabel) {
		const embedded = topBorderWithLabels(width, scrollMatch?.[1], status, modelLabel);
		if (embedded) return embedded;
	}

	if (scrollMatch?.[1]) {
		const prefix = `─── ${scrollMatch[1]} `;
		const clippedPrefix = truncateToWidth(prefix, innerWidth, "");
		const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(clippedPrefix)));
		return renderSakuraFrameGradient(`${leftCorner}${clippedPrefix}${fill}${rightCorner}`);
	}

	return renderSakuraFrameGradient(`${leftCorner}${"─".repeat(innerWidth)}${rightCorner}`);
}

/**
 * 左侧状态与滚动提示优先，右侧模型标签后留八格横线；标签保留自身配色。
 * 放不下完整状态时退到只有 spinner，其余横线按整条连续渐变。
 */
function topBorderWithLabels(width: number, scroll: string | undefined, status: BorderStatus | undefined,
	modelLabel: ((width: number) => string) | undefined): string | undefined {
	const statusHead = "╭─ ";
	const statusGap = scroll ? ` ─── ${scroll} ` : " ";
	// 右侧至少留一格横线和右角。
	const budget = Math.max(0, width - visibleWidth(statusHead) - visibleWidth(statusGap) - 2);
	let inset = budget > 0 ? status?.renderInBorder(width) ?? "" : "";
	if (visibleWidth(inset) > budget) inset = status?.renderSpinnerInBorder?.(budget) ?? "";
	inset = truncateToWidth(inset, budget, "");
	const insetWidth = visibleWidth(inset);
	const head = insetWidth > 0 ? statusHead : "╭";
	const gap = insetWidth > 0 ? statusGap : scroll ? `─── ${scroll} ` : "";
	const tailStart = visibleWidth(head) + insetWidth;
	// 模型前后各一格空白、右侧八格横线和右角，标签之间至少一格横线。
	const modelBudget = Math.max(0, width - tailStart - visibleWidth(gap) - 12);
	const model = truncateToWidth(modelLabel?.(modelBudget) ?? "", modelBudget, "");
	if (insetWidth === 0 && !model) return undefined;
	const rightTail = model ? " ────────╮" : "╮";
	const fillWidth = width - tailStart - visibleWidth(gap) - visibleWidth(model) - visibleWidth(rightTail) - (model ? 1 : 0);
	const middle = `${gap}${"─".repeat(fillWidth)}${model ? " " : ""}`;
	return `${renderSakuraFrameSegment(head, 0, width)}${inset}${renderSakuraFrameSegment(middle, tailStart, width)}${model}`
		+ renderSakuraFrameSegment(rightTail, width - visibleWidth(rightTail), width);
}

function framedBodyLine(line: string, innerWidth: number): string {
	const leftRail = renderSakuraSolid("│");
	const rightRail = renderSakuraSolid("│");
	return `${leftRail} ${fitLine(line, innerWidth)} ${rightRail}`;
}

/**
 * 仅替换 Editor 的外框：输入、补全、粘贴、历史和 Pi 应用级快捷键仍由 CustomEditor 处理。
 */
export class SakuraEditor extends CustomEditor {
	/**
	 * Pi ≥0.85 按 embedWorkingStatus + setWorkingStatusIndicator 识别可嵌入状态的输入框，
	 * 把 Working / 重试 / 压缩状态交给上边框，不再单占 statusContainer（开启 clearOnShrink 时
	 * 结束后宿主会在那里留 2 行 IdleStatus 空白）。旧宿主不识别，保持独立状态行。
	 */
	readonly embedWorkingStatus = true;
	private borderStatus: BorderStatus | undefined;

	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager,
		private readonly modelLabel?: (width: number) => string) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
	}

	/**
	 * 不转交给 CustomEditor：它会把状态画进原生横线，圆角框就认不出其中的滚动提示；
	 * 由 render 自己把状态嵌进上边框。
	 */
	setWorkingStatusIndicator(indicator: BorderStatus | undefined): void {
		this.borderStatus = indicator;
	}

	override setPaddingX(_padding: number): void {
		// 外框固定占用左右各两列，不能再叠加宿主 padding。
		super.setPaddingX(0);
	}

	override render(width: number): string[] {
		if (width < MIN_FRAME_WIDTH) return super.render(width);

		const innerWidth = width - FRAME_CHROME_WIDTH;
		const baseLines = super.render(innerWidth);
		const bottomIndex = findBottomBorderIndex(baseLines);

		if (baseLines.length < 2 || bottomIndex <= 0) return baseLines;

		const lines = [roundedBorder(width, "top", baseLines[0], this.borderStatus, this.modelLabel)];
		for (let index = 1; index < bottomIndex; index++) {
			lines.push(framedBodyLine(baseLines[index] ?? "", innerWidth));
		}
		lines.push(roundedBorder(width, "bottom", baseLines[bottomIndex]));

		// Pi 原生 autocomplete 位于底边后，保持它的定位与键盘交互不变。
		for (let index = bottomIndex + 1; index < baseLines.length; index++) {
			lines.push(baseLines[index] ?? "");
		}

		return lines.map((line) => truncateToWidth(line, width, ""));
	}
}

type InstalledEditor = {
	ui: ExtensionContext["ui"];
	factory: EditorFactory;
};

/**
 * Editor API 不支持安全地组合两个任意工厂。已有自定义 Editor 时主动让位，
 * 避免覆盖其它扩展的输入法、Vim 模式或快捷键实现。
 */
export default function installSakuraEditor(pi: ExtensionAPI, settings: FooterSettings = DEFAULT_FOOTER_SETTINGS): () => boolean {
	let installed: InstalledEditor | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || ctx.ui.getEditorComponent() !== undefined) return;

		const factory: EditorFactory = (tui, editorTheme, keybindings) =>
			new SakuraEditor(tui, editorTheme, keybindings, (width) => renderModelLabel(ctx.ui.theme,
				{ model: ctx.model, thinkingLevel: pi.getThinkingLevel() }, settings, getIcons(), width));
		installed = { ui: ctx.ui, factory };
		ctx.ui.setEditorComponent(factory);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui" || installed?.ui !== ctx.ui) return;

		// 若后加载的扩展替换了 Editor，它才是当前 owner，绝不能被我们清掉。
		if (ctx.ui.getEditorComponent() === installed.factory) ctx.ui.setEditorComponent(undefined);
		installed = undefined;
	});

	return () => installed !== undefined && installed.ui.getEditorComponent() === installed.factory;
}
