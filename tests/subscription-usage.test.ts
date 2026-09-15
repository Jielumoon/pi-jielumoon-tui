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

function usageContext(id = "a", apiKey = "mock-key"): ExtensionContext {
	return {
		model: { provider: "openrouter", id, baseUrl: "https://openrouter.ai/api/v1" },
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey } }),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey, headers: {} }),
		},
		ui: { setStatus: () => {} },
	} as unknown as ExtensionContext;
}

const usageResponse = (remaining = 8): Response => jsonResponse({ data: { limit: 10, limit_remaining: remaining } });
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
	return { promise, resolve, reject };
}

test("认证头按大小写无关的规则覆盖，不合并成多个 Bearer", async () => {
	await fetchProviderUsage("openai-codex", {
		headers: { authorization: "Bearer mock-token", "chatgpt-account-id": "old-account" }, accountId: "new-account",
	}, undefined, async (_input, init) => {
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("authorization"), "Bearer mock-token");
		assert.equal(headers.get("chatgpt-account-id"), "new-account");
		return jsonResponse({ rate_limit: { primary_window: { used_percent: 10 } } });
	});
	const ctx = usageContext();
	ctx.modelRegistry.getProviderAuth = async () => ({ auth: { headers: { Authorization: "Bearer provider" } } }) as never;
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, headers: { authorization: "Bearer model" } }) as never;
	let modelAuthorization: string | null | undefined;
	await new SubscriptionUsageController(async (_input, init) => {
		modelAuthorization = new Headers(init?.headers).get("authorization");
		return usageResponse();
	}).refresh(ctx, false);
	assert.equal(modelAuthorization, "Bearer model");
	await fetchProviderUsage("xai", {
		headers: { authorization: "Bearer mock-token", "X-Xai-Token-Auth": "stale" },
	}, undefined, async (input, init) => {
		assert.equal(new Headers(init?.headers).get("x-xai-token-auth"), "xai-grok-cli");
		return String(input).includes("format=credits")
			? jsonResponse({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" }, creditUsagePercent: 5 } })
			: jsonResponse({ config: { monthlyLimit: { val: 100 }, used: { val: 10 } } });
	});
});

test("切到缓存或不支持的模型后，旧额度结果不得重新发布", async () => {
	for (const useCache of [true, false]) {
		const response = deferred<Response>();
		let calls = 0;
		const controller = new SubscriptionUsageController(async () => ++calls === 1 ? usageResponse() : response.promise);
		const a = usageContext("a");
		await controller.refresh(a, false);
		const pending = controller.refresh(usageContext("b"), false);
		await nextTurn();
		await controller.refresh(useCache ? a : { ...a, model: undefined }, false);
		const selected = controller.getState();
		response.resolve(usageResponse(1));
		await pending;
		assert.deepEqual(controller.getState(), selected);
	}
});

test("同一账号的缓存读取不打断强制刷新", async () => {
	const response = deferred<Response>();
	let calls = 0;
	const controller = new SubscriptionUsageController(async () => ++calls === 1 ? usageResponse() : response.promise);
	const ctx = usageContext();
	await controller.refresh(ctx, false);
	const forced = controller.refresh(ctx, true);
	await nextTurn();
	assert.equal((await controller.refresh(ctx, false))?.windows[0]?.remaining, 8);
	response.resolve(usageResponse(3));
	assert.equal((await forced)?.windows[0]?.remaining, 3);
	assert.equal(calls, 2);
});

test("旧认证解析不得覆盖较新的同模型账号", async () => {
	const auth = deferred<Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>>();
	const old = usageContext("a", "old-key");
	old.modelRegistry.getApiKeyAndHeaders = () => auth.promise;
	const tokens: Array<string | null> = [];
	const controller = new SubscriptionUsageController(async (_input, init) => {
		tokens.push(new Headers(init?.headers).get("authorization"));
		return usageResponse();
	});
	const pending = controller.refresh(old, false);
	await nextTurn();
	await controller.refresh(usageContext("a", "new-key"), false);
	auth.resolve({ ok: true, apiKey: "old-key", headers: {} });
	await pending;
	assert.deepEqual(tokens, ["Bearer new-key"]);
});

test("模型实时 getter 改变时，不发布等待认证期间的旧模型额度", async () => {
	const ctx = usageContext();
	let model = ctx.model;
	Object.defineProperty(ctx, "model", { get: () => model });
	const auth = deferred<Awaited<ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>>>();
	ctx.modelRegistry.getProviderAuth = () => auth.promise;
	let requests = 0;
	const controller = new SubscriptionUsageController(async () => { requests++; return usageResponse(); });
	const pending = controller.refresh(ctx, false);
	model = usageContext("b").model;
	auth.resolve({ auth: { apiKey: "mock-key" } } as never);
	await pending;
	assert.equal(requests, 0);
	assert.equal(controller.getState(), undefined);
});

test("shutdown 作废尚未完成的认证，陈旧 context 不产生拒绝", async () => {
	for (const reject of [false, true]) {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const auth = deferred<Awaited<ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>>>();
		const ctx = usageContext();
		ctx.modelRegistry.getProviderAuth = () => auth.promise;
		let requests = 0;
		const controller = new SubscriptionUsageController(async () => { requests++; return usageResponse(); });
		controller.install({ registerCommand: () => {}, on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => handlers.set(name, handler) } as never);
		const pending = controller.refresh(ctx, false);
		handlers.get("session_shutdown")!({}, ctx);
		if (reject) auth.reject(new Error("auth unavailable"));
		else auth.resolve({ auth: { apiKey: "mock-key" } } as never);
		await pending;
		assert.equal(requests, 0);
		assert.equal(controller.getState(), undefined);
		Object.defineProperty(ctx, "model", { get: () => { throw new Error("stale after session replacement or reload"); } });
		await assert.doesNotReject(controller.refresh(ctx, false));
	}
});

test("同一 token 的账号请求头变化时隔离缓存", async () => {
	let account = "first";
	let requests = 0;
	const ctx = usageContext();
	ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: "mock-key", headers: { "ChatGPT-Account-Id": account } });
	const controller = new SubscriptionUsageController(async () => { requests++; return usageResponse(); });
	await controller.refresh(ctx, false);
	account = "second";
	await controller.refresh(ctx, false);
	assert.equal(requests, 2);
});

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
	assert.equal(new Headers(calls[0]?.headers).get("authorization"), "Bearer codex-token");
	assert.equal(new Headers(calls[0]?.headers).get("chatgpt-account-id"), "acct");
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


test("controller coalesces concurrent refreshes into a single request", async () => {
	let requests = 0;
	let releaseResponse: ((value: Response) => void) | undefined;
	const fetchImpl: UsageFetch = () => {
		requests += 1;
		return new Promise<Response>((resolve) => {
			releaseResponse = resolve;
		});
	};
	const ctx = {
		model: { provider: "openrouter", id: "test", baseUrl: "https://openrouter.ai/api/v1" },
		modelRegistry: {
			getProviderAuth: async () => ({ auth: { apiKey: "router-key" } }),
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "router-key", headers: {} }),
		},
		ui: { setStatus: () => {} },
	} as unknown as ExtensionContext;

	const controller = new SubscriptionUsageController(fetchImpl, () => 1_900_000_000_000);
	const first = controller.refresh(ctx, false);
	const second = controller.refresh(ctx, false);
	const forced = controller.refresh(ctx, true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(requests, 1, "concurrent refreshes must share one in-flight request");

	releaseResponse?.(jsonResponse({ data: { limit: 10, limit_remaining: 8 } }));
	const [a, b, c] = await Promise.all([first, second, forced]);
	assert.equal(requests, 1, "no extra request may fire after the shared one resolves");
	assert.equal(a?.windows[0]?.remaining, 8, "first caller should receive the shared snapshot");
	assert.equal(b?.windows[0]?.remaining, 8, "second caller should receive the shared snapshot");
	assert.equal(c?.windows[0]?.remaining, 8, "forced caller should reuse the in-flight request");
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
