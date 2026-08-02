import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { estimateTokens, getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatTokens, sanitizeStatusText } from "./format.ts";
import type { BlackholeCooldown, BlackholeEntry, BlackholeStatus } from "./types.ts";

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

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function readBlackholeCooldowns(): BlackholeCooldown[] {
	try {
		const cooldownPath = pathJoin(getAgentDir(), "pi-blackhole", "pi-blackhole-cooldown.json");
		const raw = asRecord(JSON.parse(readFileSync(cooldownPath, "utf8")));
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

function estimateTextTokens(text: string): number {
	return Math.ceil(text.length / 4);
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

function sourceTokensAfter(entries: BlackholeEntry[], index: number): number {
	let total = 0;
	for (let i = Math.max(0, index + 1); i < entries.length; i++) {
		if (isBlackholeSourceEntry(entries[i]!)) total += estimateBlackholeEntryTokens(entries[i]!);
	}
	return total;
}

function coverageIndex(
	entries: BlackholeEntry[],
	customType: string,
	itemsKey: "observations" | "reflections" | "observationIds",
): number {
	const indexes = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) {
		if (typeof entries[i]?.id === "string") indexes.set(entries[i]!.id as string, i);
	}

	let latest = -1;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== customType) continue;
		const data = asRecord(entry.data);
		if (!data || typeof data.coversUpToId !== "string" || !Array.isArray(data[itemsKey]) || data[itemsKey].length === 0) {
			continue;
		}
		const index = indexes.get(data.coversUpToId);
		if (index !== undefined && index > latest) latest = index;
	}
	return latest;
}

function collectBlackholeMemory(entries: BlackholeEntry[]): { poolTokens: number } {
	const observations = new Map<string, number>();
	const dropped = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		const data = asRecord(entry.data);
		if (!data) continue;

		if (entry.customType === BLACKHOLE_OBSERVATIONS && Array.isArray(data.observations)) {
			for (const item of data.observations) {
				const observation = asRecord(item);
				if (typeof observation?.id !== "string" || observations.has(observation.id)) continue;
				observations.set(observation.id, positiveNumber(observation.tokenCount, 0));
			}
		} else if (entry.customType === BLACKHOLE_DROPPED && Array.isArray(data.observationIds)) {
			for (const id of data.observationIds) if (typeof id === "string") dropped.add(id);
		}
	}

	let poolTokens = 0;
	for (const [id, tokens] of observations) if (!dropped.has(id)) poolTokens += tokens;
	return { poolTokens };
}

function blackholeCompactionTokens(entries: BlackholeEntry[]): number {
	let compactionIndex = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]?.type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) return sourceTokensAfter(entries, -1);

	const firstKeptEntryId = entries[compactionIndex]?.firstKeptEntryId;
	if (typeof firstKeptEntryId !== "string") return sourceTokensAfter(entries, compactionIndex);
	const firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
	return sourceTokensAfter(entries, firstKeptIndex < 0 ? compactionIndex : firstKeptIndex - 1);
}

export function collectBlackholeStatus(ctx: ExtensionContext): BlackholeStatus | null {
	try {
		const configPath = pathJoin(getAgentDir(), "pi-blackhole", "pi-blackhole-config.json");
		const config = asRecord(JSON.parse(readFileSync(configPath, "utf8"))) as BlackholeConfig | null;
		const manager = ctx.sessionManager as typeof ctx.sessionManager & { getBranch?: () => unknown };
		if (!config || typeof manager.getBranch !== "function") return null;

		const entries = manager.getBranch.call(manager);
		if (!Array.isArray(entries)) return null;
		const branch = entries as BlackholeEntry[];
		const memory = collectBlackholeMemory(branch);
		const compactAfter = positiveNumber(config.compactAfterTokens, 81_000);

		return {
			compaction: config.compaction === "manual" || config.compaction === "off" ? config.compaction : "auto",
			compactionEngine: config.compactionEngine === "pi-default" ? "pi-default" : "blackhole",
			memory: config.memory !== false,
			observerTokens: sourceTokensAfter(branch, coverageIndex(branch, BLACKHOLE_OBSERVATIONS, "observations")),
			observerThreshold: positiveNumber(config.observeAfterTokens, 15_000),
			reflectorTokens: sourceTokensAfter(branch, coverageIndex(branch, BLACKHOLE_REFLECTIONS, "reflections")),
			reflectorThreshold: positiveNumber(config.reflectAfterTokens, 25_000),
			poolTokens: memory.poolTokens,
			poolThreshold: positiveNumber(config.observationsPoolMaxTokens, 20_000),
			compactionTokens: blackholeCompactionTokens(branch),
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

function formatCooldownDuration(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder > 0 ? `${hours}h${remainder}m` : `${hours}h`;
}

export function formatBlackholeCooldowns(cooldowns: BlackholeCooldown[]): string {
	return cooldowns
		.map((cooldown) => `CD·${cooldown.stage}·${formatCooldownDuration(cooldown.remainingMs)}`)
		.join(" ");
}

export function formatBlackholeMetric(value: number, threshold: number): string {
	return `${formatTokens(value)}/${formatTokens(threshold)}`;
}
