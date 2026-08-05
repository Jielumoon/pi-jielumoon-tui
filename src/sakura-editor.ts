import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { renderSakuraFrameGradient, renderSakuraSolid } from "./gradient.ts";

const FRAME_CHROME_WIDTH = 4;
const MIN_FRAME_WIDTH = FRAME_CHROME_WIDTH + 1;

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

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

function roundedBorder(width: number, edge: "top" | "bottom", sourceLine?: string): string {
	if (width <= 0) return "";
	if (width === 1) return renderSakuraSolid(edge === "top" ? "╭" : "╰");

	const [leftCorner, rightCorner] = edge === "top" ? ["╭", "╮"] : ["╰", "╯"];
	const innerWidth = width - 2;
	const plainSource = sourceLine === undefined ? "" : stripAnsi(sourceLine);
	const scrollMatch = plainSource.match(/^─*\s*([↑↓]\s+\d+\s+more)\s*─*$/);

	if (scrollMatch?.[1]) {
		const prefix = `─── ${scrollMatch[1]} `;
		const clippedPrefix = truncateToWidth(prefix, innerWidth, "");
		const fill = "─".repeat(Math.max(0, innerWidth - visibleWidth(clippedPrefix)));
		return renderSakuraFrameGradient(`${leftCorner}${clippedPrefix}${fill}${rightCorner}`);
	}

	return renderSakuraFrameGradient(`${leftCorner}${"─".repeat(innerWidth)}${rightCorner}`);
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
	constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, editorTheme, keybindings, { paddingX: 0 });
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

		const lines = [roundedBorder(width, "top", baseLines[0])];
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
export default function installSakuraEditor(pi: ExtensionAPI): void {
	let installed: InstalledEditor | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || ctx.ui.getEditorComponent() !== undefined) return;

		const factory: EditorFactory = (tui, editorTheme, keybindings) =>
			new SakuraEditor(tui, editorTheme, keybindings);
		installed = { ui: ctx.ui, factory };
		ctx.ui.setEditorComponent(factory);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode !== "tui" || installed?.ui !== ctx.ui) return;

		// 若后加载的扩展替换了 Editor，它才是当前 owner，绝不能被我们清掉。
		if (ctx.ui.getEditorComponent() === installed.factory) ctx.ui.setEditorComponent(undefined);
		installed = undefined;
	});
}
