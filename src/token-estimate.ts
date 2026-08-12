/** 纯文本 token 估算：与 Pi 的 estimateTokens 对齐的 4 字符/token 近似。 */
export const CHARACTERS_PER_TOKEN = 4;

export function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
}
