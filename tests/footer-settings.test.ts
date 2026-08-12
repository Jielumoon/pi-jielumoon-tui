import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	FOOTER_SETTINGS_FILE,
	formatFooterSettingOption,
	readFooterSettings,
	registerFooterCommand,
	saveFooterSettings,
	type FooterCommandController,
} from "../src/footer/settings.ts";
import { DEFAULT_FOOTER_SETTINGS, FOOTER_SETTING_DEFINITIONS } from "../src/footer/types.ts";

/** getAgentDir 支持 PI_CODING_AGENT_DIR 覆盖；测试全部落在临时目录里。 */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function withAgentDir<T>(run: (dir: string) => T): T {
	const dir = mkdtempSync(join(tmpdir(), "pi-footer-settings-"));
	const previous = process.env[AGENT_DIR_ENV];
	process.env[AGENT_DIR_ENV] = dir;
	try {
		return run(dir);
	} finally {
		if (previous === undefined) delete process.env[AGENT_DIR_ENV];
		else process.env[AGENT_DIR_ENV] = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("read falls back to defaults for missing or malformed files", () => {
	withAgentDir((dir) => {
		assert.deepEqual(readFooterSettings(), DEFAULT_FOOTER_SETTINGS, "missing file should yield defaults");

		writeFileSync(join(dir, FOOTER_SETTINGS_FILE), "{not json", "utf8");
		assert.deepEqual(readFooterSettings(), DEFAULT_FOOTER_SETTINGS, "malformed JSON should yield defaults");

		writeFileSync(join(dir, FOOTER_SETTINGS_FILE), JSON.stringify([true]), "utf8");
		assert.deepEqual(readFooterSettings(), DEFAULT_FOOTER_SETTINGS, "non-object JSON should yield defaults");
	});
});

test("read applies only known boolean fields", () => {
	withAgentDir((dir) => {
		writeFileSync(
			join(dir, FOOTER_SETTINGS_FILE),
			JSON.stringify({
				cache: false,
				thinking: "yes",
				unknownField: false,
				planning: 0,
			}),
			"utf8",
		);
		const settings = readFooterSettings();
		assert.equal(settings.cache, false, "boolean override should apply");
		assert.equal(settings.thinking, DEFAULT_FOOTER_SETTINGS.thinking, "non-boolean value should be ignored");
		assert.equal(settings.planning, DEFAULT_FOOTER_SETTINGS.planning, "numeric value should be ignored");
		assert.ok(!("unknownField" in settings), "unknown keys must not leak into settings");
	});
});

test("save and read round-trip the full settings object", () => {
	withAgentDir(() => {
		const settings = { ...DEFAULT_FOOTER_SETTINGS, blackhole: false, toolBackground: true };
		assert.equal(saveFooterSettings(settings), true, "save should succeed in a writable agent dir");
		assert.deepEqual(readFooterSettings(), settings, "read should return exactly what was saved");
	});
});

test("setting option labels show the toggle state", () => {
	const definition = FOOTER_SETTING_DEFINITIONS.find((item) => item.key === "cache");
	assert.ok(definition, "cache definition should exist");
	assert.equal(formatFooterSettingOption({ ...DEFAULT_FOOTER_SETTINGS, cache: true }, definition), `✓ ${definition.label}`);
	assert.equal(formatFooterSettingOption({ ...DEFAULT_FOOTER_SETTINGS, cache: false }, definition), `✗ ${definition.label}`);
});

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

function makeCommandHarness() {
	let handler: CommandHandler | undefined;
	const pi = {
		registerCommand(_name: string, options: { handler: CommandHandler }) {
			handler = options.handler;
		},
	} as unknown as ExtensionAPI;

	const notices: string[] = [];
	let refreshes = 0;
	const ctx = {
		ui: {
			notify: (message: string) => {
				notices.push(message);
			},
		},
	} as unknown as ExtensionContext;

	let enabled = true;
	const controller: FooterCommandController = {
		settings: { ...DEFAULT_FOOTER_SETTINGS },
		isEnabled: () => enabled,
		setEnabled: (value: boolean) => {
			enabled = value;
		},
		refreshAndApply: () => {
			refreshes += 1;
		},
	};

	return {
		install: () => registerFooterCommand(pi, controller),
		run: (args: string) => {
			assert.ok(handler, "command handler should be registered");
			return handler!(args, ctx);
		},
		controller,
		notices,
		isEnabled: () => enabled,
		refreshCount: () => refreshes,
	};
}

test("command aliases toggle their settings and persist", async () => {
	await withAgentDir(async () => {
		const harness = makeCommandHarness();
		harness.install();

		await harness.run("tool-bg on");
		assert.equal(harness.controller.settings.toolBackground, true, "tool-bg on should enable the background");
		assert.deepEqual(readFooterSettings().toolBackground, true, "toggle must persist to disk");

		await harness.run("write-animation off");
		assert.equal(harness.controller.settings.writeAnimation, false, "write-animation off should disable animation");

		await harness.run("ctx");
		assert.equal(harness.controller.settings.context, false, "bare alias should flip the current value");
		await harness.run("ctx");
		assert.equal(harness.controller.settings.context, true, "bare alias should flip back");

		assert.ok(harness.refreshCount() >= 4, "every toggle should refresh the footer");
	});
});

test("command validates unknown actions and bad values", async () => {
	await withAgentDir(async () => {
		const harness = makeCommandHarness();
		harness.install();

		await harness.run("definitely-not-a-setting");
		assert.match(harness.notices.at(-1) ?? "", /用法/, "unknown action should print usage");

		await harness.run("cache maybe");
		assert.match(harness.notices.at(-1) ?? "", /on 或 off/, "invalid value should be rejected");
		assert.equal(harness.controller.settings.cache, true, "rejected toggle must not change the setting");

		await harness.run("off");
		assert.equal(harness.isEnabled(), false, "off should disable the footer");
		await harness.run("toggle");
		assert.equal(harness.isEnabled(), true, "toggle should re-enable the footer");
	});
});
