import { open, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAGIC_CONTEXT_CHILD_ENV = "MAGIC_CONTEXT_PI_SUBAGENT=1";
const LOG_TAIL_BYTES = 512 * 1024;
const POLL_INTERVAL_MS = 750;

type RunState = "idle" | "running" | "failed";

type MagicContextModelTrackerOptions = {
	logPath?: string;
	pollIntervalMs?: number;
	readProcessModel?: () => Promise<string | undefined>;
};

function cleanModel(value: string | undefined): string | undefined {
	const model = value?.replace(/[\x00-\x1f\x7f]/g, "").trim();
	return model || undefined;
}

function classifyStatus(statusText: string | undefined): RunState {
	if (!statusText) return "idle";
	const state = statusText.replace(/[\r\n\t]/g, " ").split("·").at(-1)?.trim().toLowerCase();
	if (!state || state === "idle") return "idle";
	if (state.startsWith("⚠") || state.includes("failed")) return "failed";
	return "running";
}

export function parseMagicContextModelLog(line: string, sessionId: string): string | undefined {
	if (!line.includes(`[magic-context][${sessionId}]`)) return undefined;

	const patterns = [
		/historian: invoking subagent \(model=([^,\s)]+)/i,
		/historian: escalating to (?:configured fallback model|session-model last resort) ([^\s]+)/i,
		/compartment agent: retrying historian with ([^\s]+)\s+\(/i,
	];
	for (const pattern of patterns) {
		const model = cleanModel(pattern.exec(line)?.[1]);
		if (model) return model;
	}
	return undefined;
}

async function readUtf8Range(path: string, start: number, length: number): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.allocUnsafe(length);
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

export async function readMagicContextProcessModel(): Promise<string | undefined> {
	if (process.platform !== "linux") return undefined;

	try {
		const processId = String(process.pid);
		const children = await readFile(`/proc/${processId}/task/${processId}/children`, "utf8");
		const childIds = children.trim().split(/\s+/).filter(Boolean).reverse();
		for (const childId of childIds) {
			try {
				const [environment, commandLine] = await Promise.all([
					readFile(`/proc/${childId}/environ`, "utf8"),
					readFile(`/proc/${childId}/cmdline`, "utf8"),
				]);
				if (!environment.split("\0").includes(MAGIC_CONTEXT_CHILD_ENV)) continue;

				const args = commandLine.split("\0").filter(Boolean);
				const modelIndex = args.lastIndexOf("--model");
				const model = cleanModel(modelIndex >= 0 ? args[modelIndex + 1] : undefined);
				if (model) return model;
			} catch {
				// 子进程可能在读取 /proc 期间退出，继续检查其余候选。
			}
		}
	} catch {
		// 非 procfs 环境由会话日志提供模型；两者都不可用时宁可不显示。
	}
	return undefined;
}

export class MagicContextModelTracker {
	private readonly logPath: string;
	private readonly pollIntervalMs: number;
	private readonly readProcessModel: () => Promise<string | undefined>;
	private readonly onChange: () => void;
	private logOffset: number | undefined;
	private logRemainder = "";
	private model: string | undefined;
	private state: RunState = "idle";
	private timer: ReturnType<typeof setInterval> | undefined;
	private refreshPromise: Promise<void> | undefined;
	private disposed = false;

	constructor(
		private readonly sessionId: string,
		onChange: () => void,
		options: MagicContextModelTrackerOptions = {},
	) {
		this.logPath = options.logPath
			?? process.env.MAGIC_CONTEXT_LOG_PATH
			?? join(tmpdir(), "pi", "magic-context", "magic-context.log");
		this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
		this.readProcessModel = options.readProcessModel ?? readMagicContextProcessModel;
		this.onChange = onChange;
	}

	observeStatus(statusText: string | undefined): string | undefined {
		const nextState = classifyStatus(statusText);
		const previousState = this.state;
		this.state = nextState;

		if (nextState === "idle") {
			this.stopPolling();
			this.model = undefined;
			return undefined;
		}

		if (nextState === "running" && previousState !== "running") this.model = undefined;
		if (nextState === "running") this.startPolling();
		else this.stopPolling();
		if (previousState === "idle" || (nextState === "failed" && previousState !== "failed")) void this.refresh();
		return this.model;
	}

	refresh(): Promise<void> {
		if (this.disposed || this.state === "idle") return Promise.resolve();
		this.refreshPromise ??= this.runRefresh().finally(() => {
			this.refreshPromise = undefined;
		});
		return this.refreshPromise;
	}

	private async runRefresh(): Promise<void> {
		const logModel = await this.readLogModel();
		const processModel = this.state === "running" ? await this.readProcessModel() : undefined;
		if (!this.disposed && this.state !== "idle") this.setModel(processModel ?? logModel);
	}

	dispose(): void {
		this.disposed = true;
		this.stopPolling();
	}

	private startPolling(): void {
		if (this.timer !== undefined || this.disposed) return;
		this.timer = setInterval(() => void this.refresh(), this.pollIntervalMs);
		this.timer.unref?.();
	}

	private stopPolling(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	private setModel(model: string | undefined): void {
		const nextModel = cleanModel(model);
		if (!nextModel || nextModel === this.model) return;
		this.model = nextModel;
		this.onChange();
	}

	private async readLogModel(): Promise<string | undefined> {
		try {
			const size = (await stat(this.logPath)).size;
			let start = this.logOffset ?? Math.max(0, size - LOG_TAIL_BYTES);
			let discardPartialFirstLine = this.logOffset === undefined && start > 0;
			if (size < start || size - start > LOG_TAIL_BYTES) {
				start = Math.max(0, size - LOG_TAIL_BYTES);
				this.logRemainder = "";
				discardPartialFirstLine = start > 0;
			}
			if (size === start) {
				this.logOffset = size;
				return undefined;
			}

			let chunk = await readUtf8Range(this.logPath, start, size - start);
			this.logOffset = size;
			if (discardPartialFirstLine) {
				const firstLineEnd = chunk.indexOf("\n");
				chunk = firstLineEnd >= 0 ? chunk.slice(firstLineEnd + 1) : "";
			}

			const lines = `${this.logRemainder}${chunk}`.split("\n");
			this.logRemainder = lines.pop() ?? "";
			let latestModel: string | undefined;
			for (const line of lines) latestModel = parseMagicContextModelLog(line, this.sessionId) ?? latestModel;
			return latestModel;
		} catch {
			return undefined;
		}
	}
}
