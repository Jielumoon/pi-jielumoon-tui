import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	fetchProviderUsage,
	formatUsageDetails,
	normalizeAnthropicUsage,
	normalizeCodexUsage,
	normalizeOpenRouterUsage,
	normalizeXaiUsage,
	SubscriptionUsageController,
	type UsageFetch,
} from "../src/footer/subscription-usage.ts";

function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

test("Codex normalizer maps primary, secondary and credits", () => {
	const usage = normalizeCodexUsage({
		plan_type: "plus",
		rate_limit: {
			primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
			secondary_window: { used_percent: 45, limit_window_seconds: 604_800, reset_at: 1_800_600_000 },
		},
		credits: { has_credits: true, balance: 3 },
	});

	assert.deepEqual(
		usage.windows.map(({ label, usedPercent }) => ({ label, usedPercent })),
		[
			{ label: "5h", usedPercent: 12 },
			{ label: "7d", usedPercent: 45 },
		],
	);
	assert.deepEqual(usage.metrics, [{ label: "Credits", value: 3 }]);
	assert.deepEqual(usage.notes, ["Plan: plus"]);
});

test("Anthropic normalizer maps plan windows and extra usage", () => {
	const usage = normalizeAnthropicUsage({
		five_hour: { utilization: 25, resets_at: "2030-01-01T00:00:00Z" },
		seven_day: { utilization: 80, resets_at: "2030-01-02T00:00:00Z" },
		extra_usage: {
			is_enabled: true,
			used_credits: 125,
			monthly_limit: 500,
			utilization: 10,
		},
	});

	assert.equal(usage.providerId, "anthropic");
	assert.equal(usage.windows[0]?.label, "5h");
	assert.equal(usage.windows[0]?.usedPercent, 25);
	assert.equal(usage.windows[2]?.label, "Extra on 125.00/500.00");
	assert.equal(usage.windows[2]?.usedPercent, 10);
	assert.match(formatUsageDetails(usage), /7d: 20% left/);
});

test("OpenRouter normalizer maps key balance and spend metrics", () => {
	const usage = normalizeOpenRouterUsage({
		data: {
			label: "main",
			limit: 20,
			limit_remaining: 12.5,
			limit_reset: "monthly",
			usage_daily: 0.25,
			usage_weekly: 1.5,
			usage: 7.5,
			is_free_tier: false,
		},
	});

	assert.deepEqual(usage.windows[0], {
		label: "Key",
		usedPercent: 37.5,
		remaining: 12.5,
		limit: 20,
		unit: "usd",
		resetDescription: "monthly",
	});
	assert.match(formatUsageDetails(usage), /Key: \$12\.50 left/);
	assert.deepEqual(
		usage.metrics.map(({ label, value }) => ({ label, value })),
		[
			{ label: "Today", value: 0.25 },
			{ label: "7d", value: 1.5 },
			{ label: "Total", value: 7.5 },
		],
	);
});

test("xAI normalizer keeps weekly data when monthly endpoint is unavailable", () => {
	const usage = normalizeXaiUsage(undefined, {
		config: {
			currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2030-01-08T00:00:00Z" },
			creditUsagePercent: 30,
		},
	});

	assert.equal(usage.providerId, "xai");
	assert.deepEqual(usage.windows.map(({ label, usedPercent }) => ({ label, usedPercent })), [
		{ label: "7d", usedPercent: 30 },
	]);
	assert.match(formatUsageDetails(usage), /^Grok usage\n7d: 70% left/);
});

test("provider requests use the four official usage contracts", async () => {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetchImpl: UsageFetch = async (input, init) => {
		const url = String(input);
		const rawHeaders = init?.headers;
		const headers: Record<string, string> = {};
		if (rawHeaders && typeof rawHeaders === "object") {
			for (const [key, value] of Object.entries(rawHeaders)) headers[key] = String(value);
		}
		calls.push({ url, headers });
		if (url.includes("chatgpt.com")) {
			return jsonResponse({ rate_limit: { primary_window: { used_percent: 10 } } });
		}
		if (url.includes("anthropic.com")) {
			return jsonResponse({ five_hour: { utilization: 20 } });
		}
		if (url.includes("openrouter.ai")) {
			return jsonResponse({ data: { limit: 10, limit_remaining: 9 } });
		}
		if (url.includes("format=credits")) {
			return jsonResponse({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" }, creditUsagePercent: 5 } });
		}
		return jsonResponse({ config: { monthlyLimit: { val: 100 }, used: { val: 10 } } });
	};

	await fetchProviderUsage("openai-codex", { apiKey: "codex-token", headers: {}, accountId: "acct" }, undefined, fetchImpl);
	await fetchProviderUsage("anthropic", { apiKey: "anthropic-token", headers: {} }, undefined, fetchImpl);
	await fetchProviderUsage("openrouter", { apiKey: "router-key", headers: {} }, undefined, fetchImpl);
	await fetchProviderUsage("xai", { apiKey: "grok-token", headers: {} }, undefined, fetchImpl);

	assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(calls[0]?.headers.Authorization, "Bearer codex-token");
	assert.equal(calls[0]?.headers["ChatGPT-Account-Id"], "acct");
	assert.equal(calls[1]?.headers["anthropic-beta"], "oauth-2025-04-20");
	assert.equal(calls[2]?.url, "https://openrouter.ai/api/v1/key");
	assert.equal(calls[3]?.headers["x-xai-token-auth"], "xai-grok-cli");
	assert.equal(calls[4]?.url, "https://cli-chat-proxy.grok.com/v1/billing?format=credits");
});

test("provider requests expose no response body on HTTP failures", async () => {
	const fetchImpl: UsageFetch = async () => jsonResponse({ secret: "must not be surfaced" }, 429, { "retry-after": "7" });
	await assert.rejects(
		fetchProviderUsage("openrouter", { apiKey: "router-key", headers: {} }, undefined, fetchImpl),
		(error: Error) => error.message === "http" && !error.message.includes("secret"),
	);
});

test("details formatting clamps malformed percentages", () => {
	const usage = normalizeAnthropicUsage({ five_hour: { utilization: 150 } });
	assert.match(formatUsageDetails(usage), /5h: 0% left/);
});


test("controller honors the success TTL and failure backoff", async () => {
	let now = 1_900_000_000_000;
	let requests = 0;
	let fail = false;
	const fetchImpl: UsageFetch = async () => {
		requests += 1;
		if (fail) return jsonResponse({ error: "hidden" }, 429, { "retry-after": "120" });
		return jsonResponse({ data: { limit: 10, limit_remaining: 8 } });
	};
	const statusCalls: Array<string | undefined> = [];
	const ctx = {
		model: { provider: "openrouter", id: "test", baseUrl: "https://openrouter.ai/api/v1" },
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "router-key" } }),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "router-key", headers: {} }),
		},
		ui: { setStatus: (_key: string, value: string | undefined) => statusCalls.push(value) },
	} as unknown as ExtensionContext;

	const controller = new SubscriptionUsageController(fetchImpl, () => now);
	let stateUpdates = 0;
	controller.subscribe(() => {
		stateUpdates += 1;
	});
	await controller.refresh(ctx, false);
	assert.equal(requests, 1);
	await controller.refresh(ctx, false);
	assert.equal(requests, 1);
	now += 61_000;
	await controller.refresh(ctx, false);
	assert.equal(requests, 2);

	fail = true;
	now += 61_000;
	await controller.refresh(ctx, false);
	assert.equal(requests, 3);
	const after429 = controller.getState();
	assert.ok(after429?.kind === "ready");
	assert.equal(after429.usage.windows[0]?.remaining, 8);
	await controller.refresh(ctx, false);
	assert.equal(requests, 3);
	const finalState = controller.getState();
	assert.ok(finalState?.kind === "ready");
	assert.equal(finalState.usage.providerId, "openrouter");
	assert.equal(finalState.usage.windows[0]?.remaining, 8);
	assert.ok(stateUpdates >= 3);
	assert.deepEqual(statusCalls, []);
});


test("/usage reports unavailable usage instead of returning silently", async () => {
	let usageHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
			if (name === "usage") usageHandler = options.handler;
		},
		on() {},
	} as unknown as ExtensionAPI;
	const controller = new SubscriptionUsageController();
	controller.install(pi);

	const notices: Array<{ message: string; level: string }> = [];
	const ctx = {
		model: undefined,
		ui: {
			notify(message: string, level: string) {
				notices.push({ message, level });
			},
		},
	} as unknown as ExtensionCommandContext;
	if (!usageHandler) throw new Error("/usage handler was not registered");
	await usageHandler("", ctx);

	assert.deepEqual(notices, [{ message: "当前模型暂无可用额度信息", level: "warning" }]);
});
