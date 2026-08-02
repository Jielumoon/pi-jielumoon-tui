import { readFileSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_FOOTER_SETTINGS,
	FOOTER_SETTING_DEFINITIONS,
	type FooterSettings,
	type FooterSettingDefinition,
} from "./types.ts";

export const FOOTER_SETTINGS_FILE = "pi-vibrant-footer.json";

export function readFooterSettings(): FooterSettings {
	const settings = { ...DEFAULT_FOOTER_SETTINGS };

	try {
		const raw = JSON.parse(readFileSync(pathJoin(getAgentDir(), FOOTER_SETTINGS_FILE), "utf8")) as unknown;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return settings;

		const values = raw as Record<string, unknown>;
		for (const definition of FOOTER_SETTING_DEFINITIONS) {
			if (typeof values[definition.key] === "boolean") {
				settings[definition.key] = values[definition.key] as boolean;
			}
		}
	} catch {
		// Missing or malformed settings use the defaults.
	}

	return settings;
}

export function saveFooterSettings(settings: FooterSettings): boolean {
	try {
		writeFileSync(
			pathJoin(getAgentDir(), FOOTER_SETTINGS_FILE),
			`${JSON.stringify(settings, null, 2)}\n`,
			"utf8",
		);
		return true;
	} catch {
		return false;
	}
}

export function formatFooterSettingOption(settings: FooterSettings, definition: FooterSettingDefinition): string {
	return `${settings[definition.key] ? "✓" : "✗"} ${definition.label}`;
}

export type FooterCommandController = {
	settings: FooterSettings;
	isEnabled(): boolean;
	setEnabled(enabled: boolean): void;
	refreshAndApply(ctx: ExtensionContext): void;
};

function persistSettings(controller: FooterCommandController, ctx: ExtensionContext): void {
	if (!saveFooterSettings(controller.settings)) {
		ctx.ui.notify(`无法保存 ${FOOTER_SETTINGS_FILE}`, "warning");
	}
}

function resetSettings(controller: FooterCommandController, ctx: ExtensionContext): void {
	Object.assign(controller.settings, DEFAULT_FOOTER_SETTINGS);
	persistSettings(controller, ctx);
	controller.refreshAndApply(ctx);
	ctx.ui.notify("已恢复 Footer 默认显示设置", "info");
}

async function openSettings(controller: FooterCommandController, ctx: ExtensionContext): Promise<void> {
	while (true) {
		const options = [
			...FOOTER_SETTING_DEFINITIONS.map((definition) => formatFooterSettingOption(controller.settings, definition)),
			"恢复默认设置",
			"完成",
		];
		const choice = await ctx.ui.select("Vibrant Footer 显示设置", options);
		if (!choice || choice === "完成") return;
		if (choice === "恢复默认设置") {
			resetSettings(controller, ctx);
			continue;
		}

		const definition = FOOTER_SETTING_DEFINITIONS.find(
			(item) => formatFooterSettingOption(controller.settings, item) === choice,
		);
		if (!definition) continue;

		controller.settings[definition.key] = !controller.settings[definition.key];
		persistSettings(controller, ctx);
		controller.refreshAndApply(ctx);
		ctx.ui.notify(`${definition.label}：${controller.settings[definition.key] ? "显示" : "隐藏"}`, "info");
	}
}

export function registerFooterCommand(pi: ExtensionAPI, controller: FooterCommandController): void {
	pi.registerCommand("jielumoon-tui", {
		description: "Configure the Jielumoon TUI footer",
		handler: async (args, ctx) => {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const action = parts[0] ?? "settings";

			if (action === "settings" || action === "config") {
				await openSettings(controller, ctx);
				return;
			}
			if (action === "reset") {
				resetSettings(controller, ctx);
				return;
			}
			if (action === "on" || action === "off") {
				controller.setEnabled(action === "on");
				controller.refreshAndApply(ctx);
				ctx.ui.notify(controller.isEnabled() ? "Jielumoon TUI 已开启" : "已恢复默认 Footer", "info");
				return;
			}
			if (action === "toggle") {
				controller.setEnabled(!controller.isEnabled());
				controller.refreshAndApply(ctx);
				ctx.ui.notify(controller.isEnabled() ? "Jielumoon TUI 已开启" : "已恢复默认 Footer", "info");
				return;
			}

			const definition = FOOTER_SETTING_DEFINITIONS.find((item) => item.aliases.includes(action));
			if (!definition) {
				ctx.ui.notify(
					"用法：/jielumoon-tui [settings|reset|on|off|<项目> [on|off]]",
					"warning",
				);
				return;
			}

			const value = parts[1];
			if (value && value !== "on" && value !== "off") {
				ctx.ui.notify("第二个参数只能是 on 或 off", "warning");
				return;
			}

			controller.settings[definition.key] = value ? value === "on" : !controller.settings[definition.key];
			persistSettings(controller, ctx);
			controller.refreshAndApply(ctx);
			ctx.ui.notify(`${definition.label}：${controller.settings[definition.key] ? "显示" : "隐藏"}`, "info");
		},
	});
}
