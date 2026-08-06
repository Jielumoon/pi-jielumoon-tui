import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import installMessageBorders from "./message-borders.ts";
import installNanoContext from "./nano-context.ts";
import installThinking from "./thinking.ts";
import installFooter from "./vibrant-footer.ts";
import installWorking from "./working.ts";
import installSakuraEditor from "./sakura-editor.ts";
import installReadmapRenderers from "./readmap-renderers.ts";

/** 注册 Jielumoon TUI 的全部自有功能。 */
export default function jielumoonTui(pi: ExtensionAPI): void {
	installNanoContext(pi);
	installFooter(pi);
	installThinking(pi);
	installMessageBorders(pi);
	installWorking(pi);
	installSakuraEditor(pi);
	installReadmapRenderers(pi);
}
