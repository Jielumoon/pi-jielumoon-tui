import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { installThinkingMessageStyle } from "./thinking-message.ts";

/** 只增加 sakura 风格的 Thought trail，不接管其它 UI surface。 */
export default function jielumoonThinking(pi: ExtensionAPI): void {
	let activeTheme: Theme | undefined;
	let cleanup: (() => void) | undefined;

	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		activeTheme = ctx.ui.theme;
		if (!cleanup) cleanup = installThinkingMessageStyle(() => activeTheme);
		ctx.ui.setHiddenThinkingLabel("✦ Thought");
	});

	pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		cleanup?.();
		cleanup = undefined;
		activeTheme = undefined;
		ctx.ui.setHiddenThinkingLabel();
	});
}
