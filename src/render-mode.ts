export type RenderMode = "color" | "plain" | "screen-reader";

/** readmap 正文与 message-borders 共用同一个输出模式入口。 */
export function resolveRenderMode(): RenderMode {
	const requested = process.env.PI_READMAP_RENDER_MODE;
	if (requested === "color" || requested === "plain" || requested === "screen-reader") {
		return requested;
	}
	return process.env.NO_COLOR === undefined ? "color" : "plain";
}
