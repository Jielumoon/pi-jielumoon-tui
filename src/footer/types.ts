import type { SubscriptionUsageState } from "./subscription-usage.ts";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export type FooterColor = ThemeColor;

export type FooterTheme = {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
};

export type IconSet = {
	path: string;
	branch: string;
	session: string;
	input: string;
	output: string;
	cacheRead: string;
	cacheWrite: string;
	cacheHit: string;
	cost: string;
	time: string;
	model: string;
	thinking: string;
	blackhole: string;
};

/**
 * Nerd Fonts v3, Material Design plane (nf-md-*, U+F0000+) — deliberately a
 * different glyph family from ~/.claude/statusline-command.sh (which uses
 * FontAwesome/Octicons), so the pi bar has its own iconographic voice.
 * Codepoints verified against ryanoasis/nerd-fonts glyphnames.json.
 */
const NERD_ICONS: IconSet = {
	path: "\u{f018b}", // nf-md-compass
	branch: "\u{f062c}", // nf-md-source_branch
	session: "\u{f04f9}", // nf-md-tag
	input: "\u{f0da3}", // nf-md-transfer_up
	output: "\u{f0da1}", // nf-md-transfer_down
	cacheRead: "\u{f035b}", // nf-md-memory
	cacheWrite: "\u{f02fa}", // nf-md-import
	cacheHit: "\u{f04fe}", // nf-md-target
	cost: "\u{f01c8}", // nf-md-diamond_stone
	time: "\u{f051f}", // nf-md-timer_sand
	model: "\u{f0768}", // nf-md-atom
	thinking: "\u{f09d1}", // nf-md-brain
	blackhole: "\u{f035b}", // nf-md-memory
};

const UNICODE_ICONS: IconSet = {
	path: "✧",
	branch: "⎇",
	session: "⌁",
	input: "↑",
	output: "↓",
	cacheRead: "▤",
	cacheWrite: "↻",
	cacheHit: "◎",
	cost: "◈",
	time: "◷",
	model: "π",
	thinking: "◆",
	blackhole: "◉",
};

function hasNerdFonts(): boolean {
	if (process.env.POWERLINE_NERD_FONTS === "0") return false;
	if (process.env.POWERLINE_NERD_FONTS === "1") return true;
	if (process.env.GHOSTTY_RESOURCES_DIR) return true;
	const term = (process.env.TERM_PROGRAM || process.env.TERM || "").toLowerCase();
	const knownBad = ["linux", "dumb"];
	if (knownBad.some((name) => term === name)) return false;
	return true;
}

export function getIcons(): IconSet {
	return hasNerdFonts() ? NERD_ICONS : UNICODE_ICONS;
}

export type UsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	cacheHitRate: number | undefined;
};

export type FooterSettings = {
	path: boolean;
	context: boolean;
	traffic: boolean;
	cache: boolean;
	cost: boolean;
	elapsed: boolean;
	provider: boolean;
	model: boolean;
	thinking: boolean;
	blackhole: boolean;
	planning: boolean;
	extensions: boolean;
};

export type FooterSettingDefinition = {
	key: keyof FooterSettings;
	label: string;
	aliases: readonly string[];
};

export const DEFAULT_FOOTER_SETTINGS: FooterSettings = {
	path: true,
	context: true,
	traffic: true,
	cache: true,
	cost: true,
	elapsed: true,
	provider: true,
	model: true,
	thinking: true,
	blackhole: true,
	extensions: true,
	planning: true,
};

export const FOOTER_SETTING_DEFINITIONS: readonly FooterSettingDefinition[] = [
	{ key: "path", label: "路径 / 分支 / 会话", aliases: ["path"] },
	{ key: "context", label: "上下文数字", aliases: ["context", "ctx"] },
	{ key: "traffic", label: "输入输出流量", aliases: ["traffic", "io"] },
	{ key: "cache", label: "缓存读写与命中率", aliases: ["cache"] },
	{ key: "cost", label: "费用 / 订阅用量", aliases: ["cost", "sub"] },
	{ key: "elapsed", label: "会话时长", aliases: ["elapsed", "time"] },
	{ key: "provider", label: "Provider", aliases: ["provider"] },
	{ key: "model", label: "Model", aliases: ["model"] },
	{ key: "thinking", label: "Thinking level", aliases: ["thinking"] },
	{ key: "blackhole", label: "Blackhole（O/R/P/C）", aliases: ["blackhole", "bh"] },
	{ key: "extensions", label: "扩展状态 / 订阅额度", aliases: ["extensions", "extension", "status", "usage"] },
	{ key: "planning", label: "计划阶段状态", aliases: ["planning", "plan", "phases"] },
];

export type BlackholeEntry = {
	type?: unknown;
	id?: unknown;
	message?: unknown;
	content?: unknown;
	summary?: unknown;
	customType?: unknown;
	data?: unknown;
	firstKeptEntryId?: unknown;
};

export type BlackholeStatus = {
	compaction: "auto" | "manual" | "off";
	compactionEngine: "blackhole" | "pi-default";
	memory: boolean;
	observerTokens: number;
	observerThreshold: number;
	reflectorTokens: number;
	reflectorThreshold: number;
	poolTokens: number;
	poolThreshold: number;
	compactionTokens: number;
	compactionThreshold: number;
	cooldowns: BlackholeCooldown[];
};

export type BlackholeCooldown = {
	stage: string;
	remainingMs: number;
};

export type ModelSnapshot = {
	provider: string;
	id: string;
	reasoning: boolean;
	contextWindow: number;
	usingOAuth: boolean;
};

export type FooterSnapshot = {
	cwd: string;
	sessionName: string | undefined;
	sessionStartMs: number;
	nowMs: number;
	model: ModelSnapshot | null;
	thinkingLevel: string;
	usage: UsageTotals;
	blackhole: BlackholeStatus | null;
};

export type FooterRenderData = {
	branch: string | null;
	extensionStatuses: ReadonlyMap<string, string>;
	subscriptionUsage?: SubscriptionUsageState;
};
