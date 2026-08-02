import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { installThinkingMessageStyle } from "./thinking-message.ts";

/** 只增加 sakura 风格的 Thought trail，不接管其它 UI surface。 */
export default function jielumoonThinking(pi: ExtensionAPI): void {
  let activeTheme: Theme | undefined;
  let installed = false;

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    activeTheme = ctx.ui.theme;
    if (!installed) {
      installThinkingMessageStyle(() => activeTheme);
      installed = true;
    }
    ctx.ui.setHiddenThinkingLabel("✦ Thought");
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    activeTheme = undefined;
    ctx.ui.setHiddenThinkingLabel();
  });
}
