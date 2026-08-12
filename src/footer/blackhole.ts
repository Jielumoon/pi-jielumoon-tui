import { readFileSync, statSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { estimateTokens, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatCooldownDuration } from "../duration.ts";
import { asRecord } from "../guards.ts";
import { estimateTextTokens } from "../token-estimate.ts";
import { formatTokens, sanitizeStatusText } from "./format.ts";
import type { BlackholeCooldown, BlackholeEntry, BlackholeStatus } from "./types.ts";

/**
 * 配置与冷却文件按 mtime+size 缓存解析结果。Footer 在 context/message_end 等
 * 高频事件上刷新，未变化时只付一次 stat 的成本，不再重复 read+parse。
 */
type JsonFileCacheEntry = { mtimeMs: number; size: number; value: unknown };
const jsonFileCache = new Map<string, JsonFileCacheEntry>();

function readJsonFileCached(path: string): unknown {
	const stats = statSync(path);
	const cached = jsonFileCache.get(path);
	if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.value;
	const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
	jsonFileCache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, value });
	return value;
}

type BlackholeConfig = {
	compaction?: "auto" | "manual" | "off";
	compactionEngine?: "blackhole" | "pi-default";
	memory?: boolean;
	observeAfterTokens?: number;
	reflectAfterTokens?: number;
	compactAfterTokens?: number;
	observationsPoolMaxTokens?: number;
};

const BLACKHOLE_OBSERVATIONS = "om.observations.recorded";
const BLACKHOLE_REFLECTIONS = "om.reflections.recorded";
const BLACKHOLE_DROPPED = "om.observations.dropped";

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readBlackholeCooldowns(): BlackholeCooldown[] {
	try {
		const cooldownPath = pathJoin(getAgentDir(), "pi-blackhole", "pi-blackhole-cooldown.json");
		const raw = asRecord(readJsonFileCached(cooldownPath));
		if (!raw) return [];

		const now = Date.now();
		return Object.values(raw)
			.map((value) => {
				const entry = asRecord(value);
				if (!entry || typeof entry.until !== "string") return null;
				const until = Date.parse(entry.until);
				if (!Number.isFinite(until) || until <= now) return null;
				const stage = typeof entry.stage === "string" ? sanitizeStatusText(entry.stage) : "model";
				return { stage: stage || "model", remainingMs: until - now };
			})
			.filter((entry): entry is BlackholeCooldown => entry !== null)
			.sort((left, right) => left.remainingMs - right.remainingMs);
	} catch {
		return [];
	}
}

function estimateBlackholeEntryTokens(entry: BlackholeEntry): number {
	try {
		if (entry.type === "message" && entry.message) {
			return estimateTokens(entry.message as Parameters<typeof estimateTokens>[0]);
		}
	} catch {
		return 0;
	}

	if (entry.type === "custom_message" && entry.content) {
		if (typeof entry.content === "string") return estimateTextTokens(entry.content);
		if (Array.isArray(entry.content)) {
			return entry.content.reduce((total, block) => {
				const record = asRecord(block);
				return record?.type === "text" && typeof record.text === "string"
					? total + estimateTextTokens(record.text)
					: total;
			}, 0);
		}
	}

	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		return estimateTextTokens(entry.summary);
	}

	return 0;
}

function isBlackholeSourceEntry(entry: BlackholeEntry): boolean {
	return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

/**
 * 会话条目只追加、内容不可变，token 估算可以跨刷新复用。
 * 唯一的例外是数组末尾的条目：它可能仍在流式写入，调用方应禁用缓存。
 */
const entryTokenCache = new WeakMap<object, number>();

function cachedEntryTokens(entry: BlackholeEntry, cacheable: boolean): number {
	if (!cacheable || typeof entry !== "object" || entry === null) {
		return estimateBlackholeEntryTokens(entry);
	}
	const cached = entryTokenCache.get(entry);
	if (cached !== undefined) return cached;
	const tokens = estimateBlackholeEntryTokens(entry);
	entryTokenCache.set(entry, tokens);
	return tokens;
}

type BlackholeBranchSummary = {
	observerTokens: number;
	reflectorTokens: number;
	poolTokens: number;
	compactionTokens: number;
};

function updateCoverageIndex(
	current: number,
	data: Record<string, unknown>,
	itemsKey: "observations" | "reflections",
	indexes: ReadonlyMap<string, number>,
): number {
	const items = data[itemsKey];
	if (!Array.isArray(items) || items.length === 0 || typeof data.coversUpToId !== "string") return current;
	const index = indexes.get(data.coversUpToId);
	return index !== undefined && index > current ? index : current;
}

/**
 * 每次基于当前 branch 重新计算（保持指标实时），但不可变条目的 token 估算
 * 通过 WeakMap 跨刷新复用；末尾条目可能仍在流式，始终重新估算。
 */
export function summarizeBlackholeBranch(entries: BlackholeEntry[]): BlackholeBranchSummary {
	const indexes = new Map<string, number>();
	const sourceTokenPrefix: number[] = [0];
	let latestCompactionIndex = -1;

	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		if (typeof entry.id === "string") indexes.set(entry.id, index);
		if (entry.type === "compaction") latestCompactionIndex = index;
		const sourceTokens = isBlackholeSourceEntry(entry)
			? cachedEntryTokens(entry, index < entries.length - 1)
			: 0;
		sourceTokenPrefix.push(sourceTokenPrefix[index]! + sourceTokens);
	}

	let observerCoverageIndex = -1;
	let reflectorCoverageIndex = -1;
	const observations = new Map<string, number>();
	const dropped = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		const data = asRecord(entry.data);
		if (!data) continue;

		if (entry.customType === BLACKHOLE_OBSERVATIONS) {
			observerCoverageIndex = updateCoverageIndex(observerCoverageIndex, data, "observations", indexes);
			if (!Array.isArray(data.observations)) continue;
			for (const item of data.observations) {
				const observation = asRecord(item);
				if (typeof observation?.id !== "string" || observations.has(observation.id)) continue;
				observations.set(observation.id, positiveNumber(observation.tokenCount, 0));
			}
			continue;
		}

		if (entry.customType === BLACKHOLE_REFLECTIONS) {
			reflectorCoverageIndex = updateCoverageIndex(reflectorCoverageIndex, data, "reflections", indexes);
			continue;
		}

		if (entry.customType === BLACKHOLE_DROPPED && Array.isArray(data.observationIds)) {
			for (const id of data.observationIds) if (typeof id === "string") dropped.add(id);
		}
	}

	const totalSourceTokens = sourceTokenPrefix.at(-1) ?? 0;
	const sourceTokensAfter = (index: number): number => {
		const prefixIndex = Math.max(0, Math.min(entries.length, index + 1));
		return totalSourceTokens - sourceTokenPrefix[prefixIndex]!;
	};

	let poolTokens = 0;
	for (const [id, tokens] of observations) if (!dropped.has(id)) poolTokens += tokens;

	let compactionCoverageIndex = -1;
	if (latestCompactionIndex >= 0) {
		compactionCoverageIndex = latestCompactionIndex;
		const firstKeptEntryId = entries[latestCompactionIndex]?.firstKeptEntryId;
		if (typeof firstKeptEntryId === "string") {
			const firstKeptIndex = indexes.get(firstKeptEntryId);
			if (firstKeptIndex !== undefined) compactionCoverageIndex = firstKeptIndex - 1;
		}
	}

	return {
		observerTokens: sourceTokensAfter(observerCoverageIndex),
		reflectorTokens: sourceTokensAfter(reflectorCoverageIndex),
		poolTokens,
		compactionTokens: sourceTokensAfter(compactionCoverageIndex),
	};
}

export function collectBlackholeStatus(ctx: ExtensionContext): BlackholeStatus | null {
	try {
		const configPath = pathJoin(getAgentDir(), "pi-blackhole", "pi-blackhole-config.json");
		const config = asRecord(readJsonFileCached(configPath)) as BlackholeConfig | undefined;
		const manager = ctx.sessionManager as typeof ctx.sessionManager & { getBranch?: () => unknown };
		if (!config || typeof manager.getBranch !== "function") return null;

		const entries = manager.getBranch.call(manager);
		if (!Array.isArray(entries)) return null;
		const branch = entries as BlackholeEntry[];
		const summary = summarizeBlackholeBranch(branch);
		const compactAfter = positiveNumber(config.compactAfterTokens, 81_000);

		return {
			compaction: config.compaction === "manual" || config.compaction === "off" ? config.compaction : "auto",
			compactionEngine: config.compactionEngine === "pi-default" ? "pi-default" : "blackhole",
			memory: config.memory !== false,
			observerTokens: summary.observerTokens,
			observerThreshold: positiveNumber(config.observeAfterTokens, 15_000),
			reflectorTokens: summary.reflectorTokens,
			reflectorThreshold: positiveNumber(config.reflectAfterTokens, 25_000),
			poolTokens: summary.poolTokens,
			poolThreshold: positiveNumber(config.observationsPoolMaxTokens, 20_000),
			compactionTokens: summary.compactionTokens,
			compactionThreshold: compactAfter,
			cooldowns: readBlackholeCooldowns(),
		};
	} catch {
		return null;
	}
}

export function blackholeMetricTone(
	status: BlackholeStatus,
	value: number,
	threshold: number,
): "success" | "warning" | "error" | "muted" {
	if (status.compaction === "off" || !status.memory) return "muted";
	const pressure = threshold > 0 ? value / threshold : 1;
	if (pressure >= 1) return "error";
	if (pressure >= 0.7) return "warning";
	return "success";
}

export function formatBlackholeCooldowns(cooldowns: BlackholeCooldown[]): string {
	return cooldowns
		.map((cooldown) => `CD·${cooldown.stage}·${formatCooldownDuration(cooldown.remainingMs)}`)
		.join(" ");
}

export function formatBlackholeMetric(value: number, threshold: number): string {
	return `${formatTokens(value)}/${formatTokens(threshold)}`;
}
