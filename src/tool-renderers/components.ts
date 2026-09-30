import { type Component, Text } from "@earendil-works/pi-tui";
import { clampLines, normalizeWidth } from "./presentation.ts";

export function reuseOrCreateText(last: Component | undefined, text: string): Text {
	if (last instanceof Text) {
		last.setText(text);
		return last;
	}
	return new Text(text, 0, 0);
}


export type WidthLineRenderer = (width: number) => string[];

/** 仅延迟依赖终端宽度的纯文本排版；外框仍由 message-borders 负责。 */
export class WidthAwareTextComponent implements Component {
	private renderLines: WidthLineRenderer;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(renderLines: WidthLineRenderer) {
		this.renderLines = renderLines;
	}

	update(renderLines: WidthLineRenderer): void {
		this.renderLines = renderLines;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		const normalized = normalizeWidth(width);
		if (this.cachedLines && this.cachedWidth === normalized) return this.cachedLines;
		this.cachedLines = clampLines(this.renderLines(normalized), normalized);
		this.cachedWidth = normalized;
		return this.cachedLines;
	}
}

export function reuseOrCreateWidthAware(
	last: Component | undefined,
	renderLines: WidthLineRenderer,
): WidthAwareTextComponent {
	if (last instanceof WidthAwareTextComponent) {
		last.update(renderLines);
		return last;
	}
	return new WidthAwareTextComponent(renderLines);
}
