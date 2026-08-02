import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContextUsageSnapshot, ModelSnapshot, UsageTotals } from "./types.ts";


export function collectUsage(ctx: ExtensionContext): UsageTotals {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;

		const message = entry.message as AssistantMessage;
		input += message.usage.input;
		output += message.usage.output;
		cacheRead += message.usage.cacheRead;
		cacheWrite += message.usage.cacheWrite;
		cost += message.usage.cost.total;
	}

	const prompt = input + cacheRead + cacheWrite;
	const cacheHitRate = prompt > 0 ? (cacheRead / prompt) * 100 : undefined;

	return { input, output, cacheRead, cacheWrite, cost, cacheHitRate };
}

export function collectContextUsage(ctx: ExtensionContext): ContextUsageSnapshot {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
	const percent = typeof usage?.percent === "number" ? usage.percent : null;

	return {
		percent,
		contextWindow: Math.max(0, contextWindow),
	};
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
