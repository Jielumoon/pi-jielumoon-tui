import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MagicContextModelTracker, parseMagicContextModelLog, readMagicContextProcessModel } from "../src/footer/magic-context-model.ts";

const sessionId = "01-test-session";
const logLine = (message: string, id = sessionId): string =>
	`[2026-08-30T11:48:43.765Z] [magic-context][${id}] ${message}\n`;

test("Magic Context 日志只解析当前会话的实际模型切换", () => {
	assert.equal(
		parseMagicContextModelLog(logLine("historian: invoking subagent (model=stepfun/step-3.7-flash, thinking=low)"), sessionId),
		"stepfun/step-3.7-flash",
	);
	assert.equal(
		parseMagicContextModelLog(logLine("historian: escalating to configured fallback model google-aistudio/gemini-3.1-flash-lite"), sessionId),
		"google-aistudio/gemini-3.1-flash-lite",
	);
	assert.equal(
		parseMagicContextModelLog(logLine("historian: escalating to session-model last resort localcch/gpt-5.6-sol"), sessionId),
		"localcch/gpt-5.6-sol",
	);
	assert.equal(
		parseMagicContextModelLog(logLine("compartment agent: retrying historian with openai-codex/gpt-5.6-luna (fallback 3/3)"), sessionId),
		"openai-codex/gpt-5.6-luna",
	);
	assert.equal(
		parseMagicContextModelLog(logLine("historian: invoking subagent (model=wrong/model)", "other-session"), sessionId),
		undefined,
	);
});

test("Magic Context 在 Linux 读取带专用标记的直属子进程模型", { skip: process.platform !== "linux" }, async (t) => {
	const child = spawn(
		process.execPath,
		["-e", "setTimeout(() => {}, 10_000)", "--", "--model", "google-aistudio/gemini-3.1-flash-lite"],
		{ env: { ...process.env, MAGIC_CONTEXT_PI_SUBAGENT: "1" } },
	);
	t.after(async () => {
		if (child.exitCode !== null) return;
		child.kill();
		await once(child, "exit");
	});
	await once(child, "spawn");

	assert.equal(await readMagicContextProcessModel(), "google-aistudio/gemini-3.1-flash-lite");
});

test("Magic Context tracker 显示运行子进程模型并在失败态保留", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-jielumoon-mc-model-"));
	t.after(async () => rm(directory, { recursive: true, force: true }));
	const logPath = join(directory, "magic-context.log");
	await writeFile(
		logPath,
		logLine("historian: invoking subagent (model=wrong/model)", "other-session")
			+ logLine("historian: invoking subagent (model=stepfun/step-3.7-flash, thinking=low)"),
		"utf8",
	);

	let processModel: string | undefined;
	let renderRequests = 0;
	const tracker = new MagicContextModelTracker(sessionId, () => renderRequests++, {
		logPath,
		pollIntervalMs: 60_000,
		readProcessModel: async () => processModel,
	});
	t.after(() => tracker.dispose());

	assert.equal(tracker.observeStatus("mc: 109.2K (54%) · historian"), undefined);
	await tracker.refresh();
	assert.equal(tracker.observeStatus("mc: 109.2K (54%) · historian"), "stepfun/step-3.7-flash");

	await appendFile(
		logPath,
		logLine("historian: escalating to configured fallback model google-aistudio/gemini-3.1-flash-lite"),
		"utf8",
	);
	await tracker.refresh();
	assert.equal(tracker.observeStatus("mc: 109.2K (54%) · historian"), "google-aistudio/gemini-3.1-flash-lite");

	processModel = "openai-codex/gpt-5.6-luna";
	await tracker.refresh();
	assert.equal(tracker.observeStatus("mc: 109.2K (54%) · recomp"), "openai-codex/gpt-5.6-luna");

	processModel = undefined;
	await appendFile(
		logPath,
		logLine("historian: escalating to session-model last resort localcch/gpt-5.6-sol"),
		"utf8",
	);
	assert.equal(
		tracker.observeStatus("mc: 109.2K (54%) · ⚠ historian failed"),
		"openai-codex/gpt-5.6-luna",
	);
	await tracker.refresh();
	assert.equal(
		tracker.observeStatus("mc: 109.2K (54%) · ⚠ historian failed"),
		"localcch/gpt-5.6-sol",
	);
	assert.equal(tracker.observeStatus("mc: 109.2K (54%) · historian"), undefined);
	assert.equal(tracker.observeStatus("mc: 109.2K (54%) · idle"), undefined);
	assert.ok(renderRequests >= 3);
});
