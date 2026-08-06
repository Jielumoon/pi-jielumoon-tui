import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	readStoredCredential,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export type UsageProviderId = "openai-codex" | "anthropic" | "openrouter" | "xai";
export type UsageUnit = "percent" | "usd";

export type UsageWindow = {
	label: string;
	usedPercent?: number;
	remaining?: number;
	limit?: number;
	unit?: UsageUnit;
	resetAt?: string;
	resetDescription?: string;
};

export type UsageMetric = {
	label: string;
	value: number | string;
	unit?: UsageUnit;
};

export type UsageSnapshot = {
	providerId: UsageProviderId;
	displayName: string;
	capturedAt: number;
	windows: UsageWindow[];
	metrics: UsageMetric[];
	notes: string[];
};

export type SubscriptionUsageNotice = "unavailable" | "retrying" | "request-failed" | "timeout";

export type SubscriptionUsageState =
	| { kind: "ready"; modelIdentity: string; usage: UsageSnapshot }
	| {
			kind: "notice";
			modelIdentity: string;
			providerId: UsageProviderId;
			displayName: string;
			notice: SubscriptionUsageNotice;
		};

export type SubscriptionUsageSource = {
	getState(): SubscriptionUsageState | undefined;
	subscribe(listener: () => void): () => void;
};

export type UsageAuth = {
	apiKey?: string;
	headers: Record<string, string>;
	accountId?: string;
};

export type UsageFetch = typeof globalThis.fetch;

const LEGACY_USAGE_STATUS_KEY = "usage";
export const USAGE_CACHE_TTL_MS = 60_000;
export const USAGE_TIMEOUT_MS = 5_000;

const MAX_SUCCESS_BODY_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;
const FAILURE_BACKOFF_MS = 60_000;

const DISPLAY_NAMES: Record<UsageProviderId, string> = {
	"openai-codex": "Codex",
	anthropic: "Claude",
	openrouter: "OpenRouter",
	xai: "Grok",
};

const OFFICIAL_ORIGINS: Record<UsageProviderId, string> = {
	"openai-codex": "https://chatgpt.com",
	anthropic: "https://api.anthropic.com",
	openrouter: "https://openrouter.ai",
	xai: "https://api.x.ai",
};

const OAUTH_PROVIDERS = new Set<UsageProviderId>(["openai-codex", "anthropic", "xai"]);

class UsageQueryError extends Error {
	readonly status: number | undefined;
	readonly retryAfterMs: number | undefined;

	constructor(message: string, options: { status?: number; retryAfterMs?: number } = {}) {
		super(message);
		this.name = "UsageQueryError";
		this.status = options.status;
		this.retryAfterMs = options.retryAfterMs;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return isObject(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function toIsoDate(value: unknown, unit: "seconds" | "iso" = "iso"): string | undefined {
	const date =
		unit === "seconds"
			? (() => {
				const seconds = asNumber(value);
				return seconds !== undefined ? new Date(seconds * 1000) : undefined;
			})()
			: typeof value === "string"
				? new Date(value)
				: undefined;
	if (!date || Number.isNaN(date.getTime())) return undefined;
	return date.toISOString();
}

export function formatUsageReset(resetAt: string | undefined, now = Date.now()): string | undefined {
	if (!resetAt) return undefined;
	const time = Date.parse(resetAt);
	if (Number.isNaN(time)) return undefined;
	const diff = time - now;
	if (diff <= 0) return "now";
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

function formatPercent(value: number): string {
	return `${clampPercent(value).toFixed(0)}%`;
}

function formatUsd(value: number): string {
	return `$${Math.max(0, value).toFixed(2)}`;
}

function formatWindowLabel(minutes: number | undefined, fallback: string): string {
	if (!minutes || !Number.isFinite(minutes) || minutes <= 0) return fallback;
	if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
	if (minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
	const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
	return entry?.[1];
}

function authorizationFrom(auth: { apiKey?: string; headers?: Record<string, string> }): string | undefined {
	return headerValue(auth.headers, "Authorization") ?? (auth.apiKey ? `Bearer ${auth.apiKey}` : undefined);
}

function bearerToken(authorization: string | undefined): string | undefined {
	const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? "");
	return match?.[1];
}

function parseRetryAfter(response: Response): number | undefined {
	const value = response.headers.get("retry-after");
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
	const date = Date.parse(value);
	const delay = date - Date.now();
	return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return response.text();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const remaining = maxBytes - total;
			if (value.byteLength > remaining) {
				if (remaining > 0) chunks.push(value.subarray(0, remaining));
				total = maxBytes;
				truncated = true;
				await reader.cancel();
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(body);
	return truncated ? `${text}…` : text;
}

async function requestJson(
	url: string,
	headers: Record<string, string>,
	signal: AbortSignal,
	fetchImpl: UsageFetch,
): Promise<unknown> {
	const controller = new AbortController();
	let timedOut = false;
	const abortFromCaller = (): void => controller.abort();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", abortFromCaller, { once: true });
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, USAGE_TIMEOUT_MS);

	try {
		const response = await fetchImpl(url, {
			headers,
			signal: controller.signal,
		});
		if (controller.signal.aborted) {
			throw new UsageQueryError(timedOut ? "timeout" : "aborted");
		}
		const text = await readBoundedText(response, response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES);
		if (!response.ok) {
			throw new UsageQueryError("http", {
				status: response.status,
				retryAfterMs: parseRetryAfter(response),
			});
		}
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new UsageQueryError("invalid-json");
		}
	} catch (error) {
		if (error instanceof UsageQueryError) throw error;
		if (timedOut) throw new UsageQueryError("timeout");
		if (signal.aborted) throw new UsageQueryError("aborted");
		throw new UsageQueryError("network");
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abortFromCaller);
	}
}

function snapshot(providerId: UsageProviderId, windows: UsageWindow[], metrics: UsageMetric[] = [], notes: string[] = []): UsageSnapshot {
	return {
		providerId,
		displayName: DISPLAY_NAMES[providerId],
		capturedAt: Date.now(),
		windows,
		metrics,
		notes,
	};
}

function addCodexWindow(
	windows: UsageWindow[],
	label: string,
	value: unknown,
	fallbackMinutes: number,
): void {
	const data = asObject(value);
	if (!data) return;
	const usedPercent = asNumber(data.used_percent);
	if (usedPercent === undefined) return;
	const windowMinutes = asNumber(data.limit_window_seconds);
	windows.push({
		label: formatWindowLabel(windowMinutes ? Math.ceil(windowMinutes / 60) : fallbackMinutes, label),
		usedPercent: clampPercent(usedPercent),
		unit: "percent",
		resetAt: toIsoDate(data.reset_at, "seconds"),
	});
}

export function normalizeCodexUsage(payload: unknown): UsageSnapshot {
	const root = asObject(payload);
	if (!root) throw new UsageQueryError("invalid-codex-payload");
	const windows: UsageWindow[] = [];
	const rateLimit = asObject(root.rate_limit);
	addCodexWindow(windows, "5h", rateLimit?.primary_window, 300);
	addCodexWindow(windows, "7d", rateLimit?.secondary_window, 10_080);

	const additional = Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : [];
	for (const item of additional) {
		const data = asObject(item);
		const limit = asObject(data?.rate_limit);
		const label = asString(data?.limit_name) ?? asString(data?.metered_feature) ?? "Extra";
		addCodexWindow(windows, label, limit?.primary_window, 300);
		addCodexWindow(windows, label, limit?.secondary_window, 10_080);
	}

	const metrics: UsageMetric[] = [];
	const credits = asObject(root.credits);
	if (credits?.unlimited === true) metrics.push({ label: "Credits", value: "unlimited" });
	else if (credits?.has_credits === true) metrics.push({ label: "Credits", value: asNumber(credits.balance) ?? "available" });
	else if (credits?.has_credits === false) metrics.push({ label: "Credits", value: "none" });
	const resetCredits = asObject(root.rate_limit_reset_credits);
	const resetCount = asNumber(resetCredits?.available_count);
	if (resetCount !== undefined) metrics.push({ label: "Reset credits", value: Math.max(0, Math.round(resetCount)) });

	if (windows.length === 0 && metrics.length === 0) throw new UsageQueryError("empty-codex-payload");
	const planType = asString(root.plan_type);
	return snapshot("openai-codex", windows, metrics, planType ? [`Plan: ${planType}`] : []);
}

export function normalizeAnthropicUsage(payload: unknown): UsageSnapshot {
	const root = asObject(payload);
	if (!root) throw new UsageQueryError("invalid-anthropic-payload");
	const windows: UsageWindow[] = [];
	const fiveHour = asObject(root.five_hour);
	const sevenDay = asObject(root.seven_day);
	const addWindow = (label: string, data: Record<string, unknown> | undefined): void => {
		const usedPercent = asNumber(data?.utilization);
		if (usedPercent === undefined) return;
		windows.push({
			label,
			usedPercent: clampPercent(usedPercent),
			unit: "percent",
			resetAt: toIsoDate(data?.resets_at),
		});
	};
	addWindow("5h", fiveHour);
	addWindow("7d", sevenDay);

	const extra = asObject(root.extra_usage);
	if (extra?.is_enabled === true) {
		const usedCredits = asNumber(extra.used_credits);
		const monthlyLimit = asNumber(extra.monthly_limit);
		const utilization = asNumber(extra.utilization);
		if (utilization !== undefined) {
			const extraStatus = (asNumber(fiveHour?.utilization) ?? 0) >= 99 ? "active" : "on";
			const amount =
				usedCredits !== undefined && monthlyLimit !== undefined
					? ` ${usedCredits.toFixed(2)}/${monthlyLimit.toFixed(2)}`
					: "";
			windows.push({
				label: `Extra ${extraStatus}${amount}`,
				usedPercent: clampPercent(utilization),
				unit: "percent",
			});
		}
	}
	if (windows.length === 0) throw new UsageQueryError("empty-anthropic-payload");
	return snapshot("anthropic", windows);
}

export function normalizeOpenRouterUsage(payload: unknown): UsageSnapshot {
	const root = asObject(payload);
	const data = asObject(root?.data);
	if (!data) throw new UsageQueryError("invalid-openrouter-payload");
	const windows: UsageWindow[] = [];
	const limit = asNumber(data.limit);
	const remaining = asNumber(data.limit_remaining);
	if (limit !== undefined && limit > 0) {
		const safeRemaining = remaining === undefined ? undefined : Math.max(0, remaining);
		windows.push({
			label: "Key",
			usedPercent: safeRemaining === undefined ? undefined : clampPercent(((limit - safeRemaining) / limit) * 100),
			remaining: safeRemaining,
			limit,
			unit: "usd",
			resetDescription: asString(data.limit_reset),
		});
	}

	const metrics: UsageMetric[] = [];
	const addMetric = (label: string, value: unknown): void => {
		const amount = asNumber(value);
		if (amount !== undefined && amount >= 0) metrics.push({ label, value: amount, unit: "usd" });
	};
	addMetric("Today", data.usage_daily);
	addMetric("7d", data.usage_weekly);
	addMetric("Month", data.usage_monthly);
	addMetric("Total", data.usage);
	const notes: string[] = [];
	if (data.limit === null) notes.push("No per-key spend cap");
	if (data.is_free_tier === true) notes.push("Free tier");
	if (windows.length === 0 && metrics.length === 0) throw new UsageQueryError("empty-openrouter-payload");
	return snapshot("openrouter", windows, metrics, notes);
}

export function normalizeXaiUsage(monthlyPayload: unknown | undefined, weeklyPayload: unknown | undefined): UsageSnapshot {
	const monthlyRoot = asObject(monthlyPayload);
	const weeklyRoot = asObject(weeklyPayload);
	const monthly = asObject(monthlyRoot?.config);
	const weekly = asObject(weeklyRoot?.config);
	const windows: UsageWindow[] = [];

	const monthlyLimit = asNumber(asObject(monthly?.monthlyLimit)?.val);
	const monthlyUsed = asNumber(asObject(monthly?.used)?.val);
	if (monthlyLimit !== undefined && monthlyLimit > 0 && monthlyUsed !== undefined) {
		windows.push({
			label: "Month",
			usedPercent: clampPercent((monthlyUsed / monthlyLimit) * 100),
			unit: "percent",
			resetAt: toIsoDate(monthly?.billingPeriodEnd),
		});
	}

	const period = asObject(weekly?.currentPeriod);
	if (asString(period?.type) === "USAGE_PERIOD_TYPE_WEEKLY") {
		const usedPercent = asNumber(weekly?.creditUsagePercent) ?? 0;
		windows.unshift({
			label: "7d",
			usedPercent: clampPercent(usedPercent),
			unit: "percent",
			resetAt: toIsoDate(weekly?.billingPeriodEnd) ?? toIsoDate(period?.end),
		});
	}
	if (windows.length === 0) throw new UsageQueryError("empty-xai-payload");
	return snapshot("xai", windows);
}

function officialOrigin(providerId: UsageProviderId, value: string | undefined): boolean {
	if (!value) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.origin === OFFICIAL_ORIGINS[providerId];
	} catch {
		return false;
	}
}

function credentialRecord(providerId: UsageProviderId): Record<string, unknown> | undefined {
	try {
		const credential = readStoredCredential(providerId);
		return asObject(credential);
	} catch {
		return undefined;
	}
}

function storedAccountId(credential: Record<string, unknown> | undefined): string | undefined {
	const direct = asString(credential?.accountId) ?? asString(credential?.account_id);
	if (direct) return direct;
	return asString(asObject(credential?.tokens)?.account_id);
}

function readGrokCliToken(): string | undefined {
	const home = process.env.GROK_HOME || join(homedir(), ".grok");
	const authPath = join(home, "auth.json");
	try {
		if (!existsSync(authPath)) return undefined;
		const data = asObject(JSON.parse(readFileSync(authPath, "utf8")));
		for (const entry of Object.values(data ?? {})) {
			const key = asString(asObject(entry)?.key);
			if (key) return key;
		}
	} catch {
		// Grok CLI 登录文件是可选的；解析失败不影响 Pi 自身认证。
	}
	return undefined;
}

function authFingerprint(providerId: UsageProviderId, auth: UsageAuth): string {
	const secret = authorizationFrom(auth) ?? auth.apiKey ?? auth.accountId ?? "";
	return `${providerId}:${createHash("sha256").update(secret).digest("hex")}`;
}

function hasOAuthCredential(credential: Record<string, unknown> | undefined): boolean {
	return credential?.type === "oauth" && Boolean(asString(credential.access));
}

async function resolveUsageAuth(ctx: ExtensionContext, providerId: UsageProviderId): Promise<UsageAuth | undefined> {
	const model = ctx.model;
	if (!model || model.provider !== providerId) return undefined;
	if (!officialOrigin(providerId, model.baseUrl)) {
		throw new UsageQueryError("custom-base-url");
	}

	const registry = ctx.modelRegistry;
	const providerResult = await registry.getProviderAuth(providerId);
	const providerAuth = providerResult?.auth;
	if (providerAuth?.baseUrl && !officialOrigin(providerId, providerAuth.baseUrl)) {
		throw new UsageQueryError("custom-base-url");
	}

	const modelResult = await registry.getApiKeyAndHeaders(model);
	if (!modelResult.ok) throw new UsageQueryError("auth");
	const headers: Record<string, string> = Object.fromEntries(
		Object.entries({ ...(providerAuth?.headers ?? {}), ...(modelResult.headers ?? {}) }).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
	const apiKey = modelResult.apiKey ?? providerAuth?.apiKey;
	const credential = credentialRecord(providerId);
	const oauth = hasOAuthCredential(credential);
	let resolvedApiKey = apiKey;
	let accountId = storedAccountId(credential);
	let overrideAuthorization = false;

	if (OAUTH_PROVIDERS.has(providerId) && !oauth) {
		if (providerId !== "xai") return undefined;
		resolvedApiKey = process.env.XAI_OAUTH_TOKEN || process.env.GROK_CLI_OAUTH_TOKEN || readGrokCliToken();
		if (!resolvedApiKey) return undefined;
		accountId = undefined;
		overrideAuthorization = true;
	}

	if (overrideAuthorization && resolvedApiKey) headers.Authorization = `Bearer ${resolvedApiKey}`;

	if (!resolvedApiKey && !authorizationFrom({ headers })) return undefined;
	return { apiKey: resolvedApiKey, headers, accountId };
}

function requestHeaders(auth: UsageAuth, extra: Record<string, string> = {}): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json", ...auth.headers, ...extra };
	const authorization = authorizationFrom(auth);
	if (authorization) headers.Authorization = authorization;
	return headers;
}

async function fetchCodex(auth: UsageAuth, signal: AbortSignal, fetchImpl: UsageFetch): Promise<UsageSnapshot> {
	const headers = requestHeaders(auth, auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {});
	const payload = await requestJson("https://chatgpt.com/backend-api/wham/usage", headers, signal, fetchImpl);
	return normalizeCodexUsage(payload);
}

async function fetchAnthropic(auth: UsageAuth, signal: AbortSignal, fetchImpl: UsageFetch): Promise<UsageSnapshot> {
	const token = bearerToken(authorizationFrom(auth));
	if (!token) throw new UsageQueryError("auth");
	const payload = await requestJson(
		"https://api.anthropic.com/api/oauth/usage",
		{
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal,
		fetchImpl,
	);
	return normalizeAnthropicUsage(payload);
}

async function fetchOpenRouter(auth: UsageAuth, signal: AbortSignal, fetchImpl: UsageFetch): Promise<UsageSnapshot> {
	const payload = await requestJson(
		"https://openrouter.ai/api/v1/key",
		requestHeaders(auth),
		signal,
		fetchImpl,
	);
	return normalizeOpenRouterUsage(payload);
}

async function fetchXai(auth: UsageAuth, signal: AbortSignal, fetchImpl: UsageFetch): Promise<UsageSnapshot> {
	const headers = requestHeaders(auth, { "x-xai-token-auth": "xai-grok-cli" });
	let monthly: unknown | undefined;
	try {
		monthly = await requestJson("https://cli-chat-proxy.grok.com/v1/billing", headers, signal, fetchImpl);
	} catch (error) {
		if (error instanceof UsageQueryError && (error.status === 401 || error.status === 403)) throw error;
	}
	const weekly = await requestJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", headers, signal, fetchImpl);
	return normalizeXaiUsage(monthly, weekly);
}

export async function fetchProviderUsage(
	providerId: UsageProviderId,
	auth: UsageAuth,
	signal: AbortSignal = new AbortController().signal,
	fetchImpl: UsageFetch = globalThis.fetch,
): Promise<UsageSnapshot> {
	switch (providerId) {
		case "openai-codex":
			return fetchCodex(auth, signal, fetchImpl);
		case "anthropic":
			return fetchAnthropic(auth, signal, fetchImpl);
		case "openrouter":
			return fetchOpenRouter(auth, signal, fetchImpl);
		case "xai":
			return fetchXai(auth, signal, fetchImpl);
	}
}

function noticeFor(error: unknown): SubscriptionUsageNotice {
	if (error instanceof UsageQueryError) {
		switch (error.message) {
			case "auth":
			case "custom-base-url":
				return "unavailable";
			case "timeout":
				return "timeout";
			default:
				return "request-failed";
		}
	}
	return "request-failed";
}


export function formatUsageDetails(usage: UsageSnapshot, now = Date.now()): string {
	const lines = [`${usage.displayName} usage`];
	for (const window of usage.windows) {
		let value = "unavailable";
		if (window.unit === "usd" && window.remaining !== undefined) {
			value = `${formatUsd(window.remaining)} left`;
		} else if (window.usedPercent !== undefined) {
			value = `${formatPercent(100 - window.usedPercent)} left`;
		}
		const reset = formatUsageReset(window.resetAt, now) ?? window.resetDescription;
		lines.push(`${window.label}: ${value}${reset ? ` (reset ${reset})` : ""}`);
	}
	for (const metric of usage.metrics) {
		const value = metric.unit === "usd" && typeof metric.value === "number" ? formatUsd(metric.value) : String(metric.value);
		lines.push(`${metric.label}: ${value}`);
	}
	lines.push(...usage.notes);
	return lines.join("\n");
}

function modelIdentity(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function isStaleContextError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("stale after session replacement or reload");
}

type CacheEntry = {
	usage: UsageSnapshot;
	fetchedAt: number;
};

export class SubscriptionUsageController implements SubscriptionUsageSource {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly failureUntil = new Map<string, number>();
	private readonly fetchImpl: UsageFetch;
	private readonly now: () => number;
	private readonly listeners = new Set<() => void>();
	private activeController: AbortController | undefined;
	private generation = 0;
	private active = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private state: SubscriptionUsageState | undefined;

	constructor(fetchImpl: UsageFetch = globalThis.fetch, now: () => number = Date.now) {
		this.fetchImpl = fetchImpl;
		this.now = now;
	}

	getState(): SubscriptionUsageState | undefined {
		return this.state;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	install(pi: ExtensionAPI): void {
		pi.registerCommand("usage", {
			description: "Show usage for the current runtime account",
			handler: async (args, ctx) => {
				if (args.trim()) {
					ctx.ui.notify("/usage 不接受参数，只显示当前模型用量", "warning");
					return;
				}
				const usage = await this.refresh(ctx, true);
				if (usage) {
					ctx.ui.notify(formatUsageDetails(usage, this.now()), "info");
					return;
				}
				ctx.ui.notify("当前模型暂无可用额度信息", "warning");
			},
		});

		pi.on("session_start", (_event, ctx) => {
			this.active = true;
			this.clearLegacyStatus(ctx);
			this.setState(undefined);
			void this.refresh(ctx, false);
		});
		pi.on("session_tree", (_event, ctx) => {
			if (this.active) void this.refresh(ctx, false);
		});
		pi.on("model_select", (_event, ctx) => {
			if (this.active) void this.refresh(ctx, false);
		});
		pi.on("turn_start", (_event, ctx) => {
			if (this.active) void this.refresh(ctx, false);
		});
		pi.on("agent_end", (_event, ctx) => {
			if (this.active) void this.refresh(ctx, false);
		});
		pi.on("session_shutdown", (_event, ctx) => {
			this.active = false;
			this.generation += 1;
			this.activeController?.abort();
			this.activeController = undefined;
			this.clearTimer();
			this.cache.clear();
			this.failureUntil.clear();
			this.setState(undefined);
			this.clearLegacyStatus(ctx);
		});
	}

	async refresh(ctx: ExtensionContext | ExtensionCommandContext, force: boolean): Promise<UsageSnapshot | undefined> {
		const providerId = providerIdFor(ctx.model?.provider);
		const identity = modelIdentity(ctx);
		if (!providerId || !identity) {
			this.clearTimer();
			this.setState(undefined);
			return undefined;
		}
		if (this.state?.modelIdentity !== identity) this.setState(undefined);

		const requestGeneration = ++this.generation;
		this.activeController?.abort();
		const controller = new AbortController();
		this.activeController = controller;
		let cacheKey: string | undefined;
		let cached: CacheEntry | undefined;
		try {
			const auth = await resolveUsageAuth(ctx, providerId);
			if (!auth) {
				this.setNotice(identity, providerId, "unavailable");
				return undefined;
			}
			cacheKey = `${identity}:${authFingerprint(providerId, auth)}`;
			cached = this.cache.get(cacheKey);
			if (!force && cached && this.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
				this.setReady(identity, cached.usage);
				this.schedule(ctx, USAGE_CACHE_TTL_MS - (this.now() - cached.fetchedAt));
				return cached.usage;
			}
			const failureUntil = this.failureUntil.get(cacheKey) ?? 0;
			if (!force && failureUntil > this.now()) {
				if (cached) this.setReady(identity, cached.usage);
				else this.setNotice(identity, providerId, "retrying");
				this.schedule(ctx, failureUntil - this.now());
				return cached?.usage;
			}

			const usage = await fetchProviderUsage(providerId, auth, controller.signal, this.fetchImpl);
			if (controller.signal.aborted || requestGeneration !== this.generation) return undefined;
			this.cache.set(cacheKey, { usage, fetchedAt: this.now() });
			this.failureUntil.delete(cacheKey);
			this.setReady(identity, usage);
			this.schedule(ctx, USAGE_CACHE_TTL_MS);
			return usage;
		} catch (error) {
			if (controller.signal.aborted || requestGeneration !== this.generation || isStaleContextError(error)) return undefined;
			const retryAfterMs = error instanceof UsageQueryError ? error.retryAfterMs : undefined;
			const backoff = Math.max(FAILURE_BACKOFF_MS, retryAfterMs ?? 0);
			if (cacheKey) this.failureUntil.set(cacheKey, this.now() + backoff);
			if (error instanceof UsageQueryError && error.status === 429 && cached) {
				this.setReady(identity, cached.usage);
			} else {
				this.setNotice(identity, providerId, noticeFor(error));
			}
			this.schedule(ctx, backoff);
			return undefined;
		} finally {
			if (this.activeController === controller) this.activeController = undefined;
		}
	}

	private setReady(modelIdentity: string, usage: UsageSnapshot): void {
		this.setState({ kind: "ready", modelIdentity, usage });
	}

	private setNotice(modelIdentity: string, providerId: UsageProviderId, notice: SubscriptionUsageNotice): void {
		this.setState({ kind: "notice", modelIdentity, providerId, displayName: DISPLAY_NAMES[providerId], notice });
	}

	private setState(state: SubscriptionUsageState | undefined): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}

	private schedule(ctx: ExtensionContext, delayMs: number): void {
		this.clearTimer();
		if (!this.active || delayMs <= 0) return;
		const generation = this.generation;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (generation === this.generation && this.active) void this.refresh(ctx, false);
		}, delayMs);
		this.timer.unref?.();
	}

	private clearTimer(): void {
		if (this.timer === undefined) return;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private clearLegacyStatus(ctx: ExtensionContext | ExtensionCommandContext): void {
		try {
			ctx.ui.setStatus(LEGACY_USAGE_STATUS_KEY, undefined);
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
	}
}

function providerIdFor(value: string | undefined): UsageProviderId | undefined {
	switch (value) {
		case "openai-codex":
		case "anthropic":
		case "openrouter":
		case "xai":
			return value;
		default:
			return undefined;
	}
}

export default function installSubscriptionUsage(pi: ExtensionAPI): SubscriptionUsageSource {
	const controller = new SubscriptionUsageController();
	controller.install(pi);
	return controller;
}
