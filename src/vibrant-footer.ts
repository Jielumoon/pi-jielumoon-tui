/**
 * Vibrant status footer for pi.
 *
 * The footer is deliberately only a lifecycle controller. Data collection,
 * Blackhole integration, settings, formatting, and rendering live in footer/.
 * The dedicated nano-context widget owns the visual context bar below the editor.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectBlackholeStatus } from "./footer/blackhole.ts";
import { renderFooter } from "./footer/render.ts";
import { registerFooterCommand, readFooterSettings } from "./footer/settings.ts";
import { getIcons, type FooterSnapshot } from "./footer/types.ts";
import {
	collectContextUsage,
	collectModelSnapshot,
	SessionUsageCollector,
} from "./footer/usage.ts";
import type { SubscriptionUsageSource } from "./footer/subscription-usage.ts";

const REFRESH_INTERVAL_MS = 30_000;

export default function vibrantFooter(pi: ExtensionAPI, subscriptionUsage?: SubscriptionUsageSource): void {
	const settings = readFooterSettings();
	const usageCollector = new SessionUsageCollector();
	let enabled = true;
	let sessionStartMs = Date.now();
	let activeContext: ExtensionContext | undefined;
	let snapshot: FooterSnapshot | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let requestRender: (() => void) | undefined;

	type SnapshotRefreshOptions = {
		usage?: boolean;
	};

	const refreshSnapshot = (ctx: ExtensionContext, options: SnapshotRefreshOptions = {}): void => {
		activeContext = ctx;
		const previous = snapshot;
		const refreshUsage = previous === undefined || options.usage === true;
		const usage = refreshUsage ? usageCollector.collect(ctx) : previous.usage;
		// O/R/P/C 与 context 一样读取当前 branch；这里不复用旧指标。
		const blackhole = settings.blackhole ? collectBlackholeStatus(ctx) : null;

		snapshot = {
			cwd: ctx.cwd,
			sessionName: ctx.sessionManager.getSessionName(),
			sessionStartMs,
			nowMs: Date.now(),
			context: collectContextUsage(ctx),
			model: collectModelSnapshot(ctx),
			thinkingLevel: pi.getThinkingLevel(),
			usage,
			blackhole,
		};
		requestRender?.();
	};

	const stopRefreshLoop = (): void => {
		if (refreshTimer === undefined) return;
		clearInterval(refreshTimer);
		refreshTimer = undefined;
	};

	const startRefreshLoop = (ctx: ExtensionContext): void => {
		stopRefreshLoop();
		if (ctx.mode !== "tui") return;

		refreshTimer = setInterval(() => {
			if (enabled && activeContext) refreshSnapshot(activeContext);
		}, REFRESH_INTERVAL_MS);
	};

	const applyFooter = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;

		if (!enabled) {
			requestRender = undefined;
			ctx.ui.setFooter(undefined);
			return;
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const renderRequest = (): void => tui.requestRender();
			requestRender = renderRequest;
			const unsubscribeBranch = footerData.onBranchChange(() => {
				if (activeContext) refreshSnapshot(activeContext);
				else renderRequest();
			});
			const unsubscribeSubscriptionUsage = subscriptionUsage?.subscribe(renderRequest);

			return {
				dispose() {
					unsubscribeBranch();
					unsubscribeSubscriptionUsage?.();
					if (requestRender === renderRequest) requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					if (!snapshot) return [];
					return renderFooter(
						snapshot,
						settings,
						{
							branch: footerData.getGitBranch(),
							extensionStatuses: footerData.getExtensionStatuses(),
							subscriptionUsage: subscriptionUsage?.getState(),
						},
						width,
						theme,
						getIcons(),
					);
				},
			};
		});
	};

	const refreshAndApply = (ctx: ExtensionContext): void => {
		refreshSnapshot(ctx, { usage: true });
		applyFooter(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		sessionStartMs = Date.now();
		usageCollector.reset();
		snapshot = undefined;
		refreshSnapshot(ctx);
		applyFooter(ctx);
		startRefreshLoop(ctx);
	});

	const refreshLightweight = (_event: unknown, ctx: ExtensionContext): void => {
		if (enabled) refreshSnapshot(ctx);
	};

	const refreshWithUsage = (_event: unknown, ctx: ExtensionContext): void => {
		if (enabled) refreshSnapshot(ctx, { usage: true });
	};

	pi.on("context", refreshLightweight);
	pi.on("message_end", refreshLightweight);
	pi.on("agent_end", refreshWithUsage);
	pi.on("session_compact", refreshWithUsage);
	pi.on("session_tree", refreshWithUsage);
	pi.on("model_select", refreshLightweight);
	pi.on("thinking_level_select", refreshLightweight);

	pi.on("session_shutdown", (_event, ctx) => {
		stopRefreshLoop();
		usageCollector.reset();
		requestRender = undefined;
		activeContext = undefined;
		snapshot = undefined;
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});

	registerFooterCommand(pi, {
		settings,
		isEnabled: () => enabled,
		setEnabled: (value: boolean) => {
			enabled = value;
		},
		refreshAndApply,
	});
}
