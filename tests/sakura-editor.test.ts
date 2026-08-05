import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { type EditorTheme, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import installSakuraEditor, { SakuraEditor } from "../src/sakura-editor.ts";

const stripAnsi = (text: string): string =>
	text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

const tui = {
	terminal: { rows: 24 },
	requestRender() {},
} as unknown as TUI;

const editorTheme: EditorTheme = {
	borderColor: (text) => text,
	selectList: {
		selectedPrefix: (text) => text,
		selectedText: (text) => text,
		description: (text) => text,
		scrollInfo: (text) => text,
		noMatch: (text) => text,
	},
};

function keybindings(matches = (_data: string, _action: string) => false): KeybindingsManager {
	return { matches } as unknown as KeybindingsManager;
}

function createEditor(): SakuraEditor {
	return new SakuraEditor(tui, editorTheme, keybindings());
}

test("Sakura Editor renders a fixed-width rounded macaron frame", () => {
	const editor = createEditor();
	editor.setPaddingX(8);
	editor.setText("给宝宝写一条消息");

	const lines = editor.render(32);
	const plainLines = lines.map(stripAnsi);

	assert.equal(editor.getPaddingX(), 0);
	assert.equal(plainLines[0], `╭${"─".repeat(30)}╮`);
	assert.match(plainLines[1] ?? "", /^│ 给宝宝写一条消息/);
	assert.match(plainLines[1] ?? "", / │$/);
	assert.equal(plainLines.at(-1), `╰${"─".repeat(30)}╯`);
	assert.ok(lines[0]?.includes("\x1b[38;2;"));
	assert.ok(lines.every((line) => visibleWidth(line) === 32));
});

test("Sakura Editor keeps literal horizontal-rule input and falls back on narrow widths", () => {
	const editor = createEditor();
	editor.setText("────────");

	assert.match(stripAnsi(editor.render(24)[1] ?? ""), /────────/);

	const narrowLines = editor.render(4).map(stripAnsi);
	assert.equal(narrowLines[0], "────");
	assert.ok(!narrowLines[0]?.startsWith("╭"));
});

test("Sakura Editor preserves Pi scrolling and app-level key handling", () => {
	const editor = new SakuraEditor(
		tui,
		editorTheme,
		keybindings((data, action) => data === action),
	);
	let exited = false;
	editor.onAction("app.exit", () => {
		exited = true;
	});
	editor.handleInput("app.exit");
	assert.equal(exited, true);

	editor.setText(Array.from({ length: 20 }, (_value, index) => `line ${index + 1}`).join("\n"));
	const lines = editor.render(32).map(stripAnsi);
	assert.match(lines[0] ?? "", /^╭─── ↑ \d+ more /);
	assert.ok(lines.every((line) => visibleWidth(line) === 32));
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

type EditorHarness = {
	emit(event: string): void;
	getFactory(): EditorFactory | undefined;
	setFactory(factory: EditorFactory | undefined): void;
};

function installEditorHarness(initialFactory?: EditorFactory): EditorHarness {
	const handlers = new Map<string, Handler[]>();
	let factory = initialFactory;
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		mode: "tui",
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent: (nextFactory: EditorFactory | undefined) => {
				factory = nextFactory;
			},
		},
	} as unknown as ExtensionContext;

	installSakuraEditor(pi);
	return {
		emit(event: string) {
			for (const handler of handlers.get(event) ?? []) handler({ type: event }, ctx);
		},
		getFactory: () => factory,
		setFactory(nextFactory) {
			factory = nextFactory;
		},
	};
}

test("Sakura Editor yields to another editor and only cleans up its own factory", () => {
	const existingFactory: EditorFactory = (currentTui, theme, bindings) =>
		new SakuraEditor(currentTui, theme, bindings);
	const yielded = installEditorHarness(existingFactory);
	yielded.emit("session_start");
	assert.equal(yielded.getFactory(), existingFactory);
	yielded.emit("session_shutdown");
	assert.equal(yielded.getFactory(), existingFactory);

	const owned = installEditorHarness();
	owned.emit("session_start");
	const installedFactory = owned.getFactory();
	assert.ok(installedFactory);
	assert.ok(installedFactory(tui, editorTheme, keybindings()) instanceof SakuraEditor);

	const laterFactory: EditorFactory = (currentTui, theme, bindings) =>
		new SakuraEditor(currentTui, theme, bindings);
	owned.setFactory(laterFactory);
	owned.emit("session_shutdown");
	assert.equal(owned.getFactory(), laterFactory);
});
