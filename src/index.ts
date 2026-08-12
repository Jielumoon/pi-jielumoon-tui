import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import installMessageBorders from "./message-borders.ts";
import installNanoContext from "./nano-context.ts";
import installThinking from "./thinking.ts";
import installFooter from "./vibrant-footer.ts";
import installWorking from "./working.ts";
import installSakuraEditor from "./sakura-editor.ts";
import installReadmapRenderers from "./readmap-renderers/index.ts";
import installSubscriptionUsage from "./footer/subscription-usage.ts";
import { readFooterSettings } from "./footer/settings.ts";

/** 注册 Jielumoon TUI 的全部自有功能。 */
export default function jielumoonTui(pi: ExtensionAPI): void {
	const footerSettings = readFooterSettings();
	installNanoContext(pi, footerSettings);
	const subscriptionUsage = installSubscriptionUsage(pi);
	installFooter(pi, subscriptionUsage, footerSettings);
	installThinking(pi);
	installMessageBorders(pi, footerSettings);
	installWorking(pi);
	installSakuraEditor(pi);
	installReadmapRenderers(pi, footerSettings);
}
