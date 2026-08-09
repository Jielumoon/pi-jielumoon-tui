/** Sakura 活动 spinner、重试/压缩状态和长任务耗时 transcript。 */

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { Loader, Text } from "@earendil-works/pi-tui";
import { SAKURA_SPINNER_FRAMES } from "./gradient";
import { installPrototypePatch } from "./prototype-patch-registry";

const WORKING_UPDATE_INTERVAL_MS = 1000;
const SPINNER_INTERVAL_MS = 80;
const MIN_ELAPSED_TRANSCRIPT_MS = 5000;
const ELAPSED_ENTRY_TYPE = "pi-jielumoon-elapsed";


function formatElapsed(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function indicator(): WorkingIndicatorOptions {
	return {
		frames: SAKURA_SPINNER_FRAMES,
		intervalMs: SPINNER_INTERVAL_MS,
	};
}

export function renderWorkingMessage(theme: Theme, elapsedMs: number): string {
	return `${theme.fg("text", "Working")}${theme.fg("dim", ` · ${formatElapsed(elapsedMs)}`)}`;
}

interface StatusLoaderState {
	kind?: unknown;
	message?: unknown;
	setText(text: string): void;
	ui?: { requestRender?: () => void } | null;
}

type ElapsedEntryData = { elapsedMs?: unknown };

function isAnimatedStatus(loader: StatusLoaderState, message: string): boolean {
	return (
		loader.kind === "retry" ||
		loader.kind === "compaction" ||
		message.startsWith("Retrying (") ||
		message.includes("Compacting context...") ||
		message.includes("Auto-compacting...")
	);
}

/**
 * Pi 的 retry/compaction loader 不使用 working indicator 配置；只改这两类，
 * 不碰 Bash loader、branch summary 或其它宿主组件。
 *
 * 该 patch 按进程安装而非 session 清理，因为 session switch 会复用同一组
 * Loader 原型；清理它会让后续 session 静默退回 Pi 默认渲染。
 */
function installStatusGradients(): void {
	const spinnerTicks = new WeakMap<object, number>();
	try {
		installPrototypePatch(
			Loader.prototype,
			"updateDisplay",
			"loader-status-update",
			({ predecessor, receiver, args }) => {
				const loader = receiver as StatusLoaderState;
				const message = typeof loader.message === "string" ? loader.message : "";
				if (!isAnimatedStatus(loader, message)) {
					return Reflect.apply(predecessor, receiver, args);
				}

				const tick = spinnerTicks.get(receiver as object) ?? 0;
				spinnerTicks.set(receiver as object, tick + 1);
				const spinner = SAKURA_SPINNER_FRAMES[tick % SAKURA_SPINNER_FRAMES.length] ?? "";
				loader.setText(`${spinner} ${message}`);
				loader.ui?.requestRender?.();
				return undefined;
			},
		);
	} catch {
		// Loader 是 Pi 的内部组件；升级后若方法不存在，保留宿主默认行为。
	}
}

export default function installWorking(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	let startedAt: number | undefined;

	installStatusGradients();

	const stop = () => {
		if (timer === undefined) return;
		clearInterval(timer);
		timer = undefined;
	};

	const render = (ctx: ExtensionContext) => {
		if (startedAt === undefined) return;
		ctx.ui.setWorkingMessage(renderWorkingMessage(ctx.ui.theme, Date.now() - startedAt));
	};

	pi.registerEntryRenderer<ElapsedEntryData>(ELAPSED_ENTRY_TYPE, (entry, _options, theme) => {
		const elapsedMs = typeof entry.data?.elapsedMs === "number" ? entry.data.elapsedMs : 0;
		return new Text(theme.fg("dim", `  · ${formatElapsed(elapsedMs)}`), 0, 0);
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingIndicator(indicator());
	});

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (startedAt === undefined) {
			startedAt = Date.now();
		}
		ctx.ui.setWorkingIndicator(indicator());
		render(ctx);
		timer ??= setInterval(() => render(ctx), WORKING_UPDATE_INTERVAL_MS);
	});

	pi.on("agent_settled", (_event, ctx) => {
		stop();
		const elapsedMs = startedAt === undefined ? undefined : Date.now() - startedAt;
		startedAt = undefined;
		if (ctx.mode !== "tui") return;
		if (elapsedMs !== undefined && elapsedMs >= MIN_ELAPSED_TRANSCRIPT_MS) {
			pi.appendEntry(ELAPSED_ENTRY_TYPE, { elapsedMs });
		}
		ctx.ui.setWorkingMessage();
	});

	pi.on("session_shutdown", () => {
		stop();
		startedAt = undefined;
	});
}
