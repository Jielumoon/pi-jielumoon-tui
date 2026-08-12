/**
 * 终端转义序列的样式处理工具。
 *
 * 注意与 readmap 的 sanitizeTerminalText 区分：这里只做“剥离样式后测量/比较”，
 * 后者面向外部不可信文本的注入防护，二者不要合并。
 */

/** 移除 OSC 与 CSI 序列，保留可见字符。 */
export function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

/** 单次移除行尾空格补齐，保留其后的 ANSI reset（Thought trail 行处理）。 */
export function removeTrailingPadding(line: string): string {
	return line.replace(
		/ +((?:(?:\x1b\[[0-?]*[ -/]*[@-~])|(?:\x1b\][^\x07]*(?:\x07|\x1b\\)))*)$/,
		"$1",
	);
}

const TRAILING_TERMINAL_PADDING = /[ \t]+((?:(?:\x1b\[[0-?]*[ -/]*[@-~])|(?:\x1b\][^\x07]*(?:\x07|\x1b\\)))*)$/;

/** 反复移除 Text 为整行补齐的尾空格/制表符直到不动点，保留 ANSI reset（工具卡标题处理）。 */
export function trimTerminalPadding(line: string): string {
	let trimmed = line;
	while (true) {
		const next = trimmed.replace(TRAILING_TERMINAL_PADDING, "$1");
		if (next === trimmed) return trimmed;
		trimmed = next;
	}
}
