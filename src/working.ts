/** pi-ui 风格的工作状态渐变、重试/压缩状态和耗时 transcript。 */

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { Loader, Text } from "@earendil-works/pi-tui";
import { renderSakuraGradient } from "./gradient";
import { installPrototypePatch } from "./prototype-patch-registry";

const WORKING_UPDATE_INTERVAL_MS = 180;
const SPINNER_INTERVAL_MS = 80;
const SHIMMER_PERIOD_MS = 2800;
const ELAPSED_ENTRY_TYPE = "pi-jielumoon-elapsed";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const MACARON_SPINNER_FRAMES = SPINNER_FRAMES.map((frame) => renderSakuraGradient(frame));

function shimmerPhase(now = Date.now()): number {
	return (((now % SHIMMER_PERIOD_MS) + SHIMMER_PERIOD_MS) % SHIMMER_PERIOD_MS) / SHIMMER_PERIOD_MS;
}

function formatElapsed(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function indicator(): WorkingIndicatorOptions {
	return {
		frames: MACARON_SPINNER_FRAMES,
		intervalMs: SPINNER_INTERVAL_MS,
	};
}

function workingMessage(theme: Theme, elapsedMs: number): string {
	const word = renderSakuraGradient("Working", shimmerPhase());
	const suffix = theme.fg("dim", ` (${formatElapsed(elapsedMs)} · esc to interrupt)`);
	return `${word}${suffix}`;
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
				const phase = shimmerPhase();
				const spinner = MACARON_SPINNER_FRAMES[tick % MACARON_SPINNER_FRAMES.length] ?? "";
				loader.setText(`${spinner} ${renderSakuraGradient(message, phase)}`);
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
		ctx.ui.setWorkingMessage(workingMessage(ctx.ui.theme, Date.now() - startedAt));
	};

	pi.registerEntryRenderer<ElapsedEntryData>(ELAPSED_ENTRY_TYPE, (entry, _options, theme) => {
		const elapsedMs = typeof entry.data?.elapsedMs === "number" ? entry.data.elapsedMs : 0;
		return new Text(theme.fg("dim", `  Worked for ${formatElapsed(elapsedMs)}`), 0, 0);
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
		if (elapsedMs !== undefined) pi.appendEntry(ELAPSED_ENTRY_TYPE, { elapsedMs });
		ctx.ui.setWorkingMessage();
	});

	pi.on("session_shutdown", () => {
		stop();
		startedAt = undefined;
	});
}
