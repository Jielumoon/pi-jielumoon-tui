import type { Usage } from "@earendil-works/pi-ai";
import { type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ModelSnapshot, UsageTotals } from "./types.ts";

type UsageCounters = Omit<UsageTotals, "cacheHitRate">;

const emptyUsageCounters = (): UsageCounters => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
});

const finalizeUsage = (totals: UsageCounters): UsageTotals => {
	const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
	return {
		...totals,
		cacheHitRate: prompt > 0 ? (totals.cacheRead / prompt) * 100 : undefined,
	};
};

/** 会话条目只追加，因此只累计本次新增的条目。 */
export class SessionUsageCollector {
	private entryCount = 0;
	private lastEntry: SessionEntry | undefined;
	private totals = emptyUsageCounters();

	reset(): void {
		this.entryCount = 0;
		this.lastEntry = undefined;
		this.totals = emptyUsageCounters();
	}

	collect(ctx: ExtensionContext): UsageTotals {
		const entries = ctx.sessionManager.getEntries();
		const prefixIsStable =
			this.entryCount <= entries.length &&
			(this.entryCount === 0 || entries[this.entryCount - 1] === this.lastEntry);
		if (!prefixIsStable) this.reset();

		for (let index = this.entryCount; index < entries.length; index++) {
			const entry = entries[index]!;
			let usage: Usage | undefined;
			if (entry.type === "compaction" || entry.type === "branch_summary") usage = entry.usage;
			else if (entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) {
				usage = entry.message.usage;
			}
			if (!usage) continue;
			this.totals.input += usage.input;
			this.totals.output += usage.output;
			this.totals.cacheRead += usage.cacheRead;
			this.totals.cacheWrite += usage.cacheWrite;
			this.totals.cost += usage.cost.total;
		}

		this.entryCount = entries.length;
		this.lastEntry = entries.at(-1);
		return finalizeUsage(this.totals);
	}
}

export function collectUsage(ctx: ExtensionContext): UsageTotals {
	return new SessionUsageCollector().collect(ctx);
}

export function collectModelSnapshot(ctx: ExtensionContext): ModelSnapshot | null {
	const model = ctx.model;
	if (!model) return null;

	let usingOAuth = false;
	try {
		usingOAuth = ctx.modelRegistry.isUsingOAuth(model);
	} catch {
		usingOAuth = false;
	}

	return {
		provider: model.provider,
		id: model.id,
		reasoning: model.reasoning,
		contextWindow: model.contextWindow,
		usingOAuth,
	};
}
