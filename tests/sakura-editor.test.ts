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


test("Sakura Editor seals paste placeholders and long content at every width", () => {
	for (const text of ["[paste #1 +11 lines]", "x".repeat(300), "中文".repeat(120)]) {
		for (const width of [5, 6, 7, 8, 10, 20, 40, 80, 160]) {
			const editor = createEditor();
			editor.setText(text);
			const lines = editor.render(width);
			const plain = lines.map(stripAnsi);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			if (width < 7) {
				assert.ok(!plain[0]?.startsWith("╭"));
				continue;
			}
			assert.ok(lines.every((line) => visibleWidth(line) === width));
			assert.match(plain[0] ?? "", /^╭.*╮$/);
			assert.match(plain.at(-1) ?? "", /^╰.*╯$/);
		}
	}
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

test("Sakura Editor 把宿主状态嵌进上边框，清除后恢复普通边框", () => {
	const status = {
		renderInBorder: () => "\x1b[35m⠋\x1b[39m Working · 12s",
		renderSpinnerInBorder: () => "\x1b[35m⠋\x1b[39m",
	};
	const editor = createEditor();
	// Pi ≥0.85 靠这两项 duck-type 识别，缺一项就退回独立状态行（结束后留白）。
	assert.equal(editor.embedWorkingStatus, true);
	assert.equal(typeof editor.setWorkingStatusIndicator, "function");

	editor.setWorkingStatusIndicator(status);
	const top = editor.render(32)[0] ?? "";
	assert.equal(stripAnsi(top), `╭─ ⠋ Working · 12s ${"─".repeat(12)}╮`);
	assert.ok(top.includes("\x1b[35m⠋\x1b[39m"), "状态保留自身配色");
	assert.equal(stripAnsi(editor.render(12)[0] ?? ""), "╭─ ⠋ ──────╮", "放不下完整状态时只留 spinner");
	for (const width of [7, 8, 10, 20, 40, 80]) {
		assert.ok(editor.render(width).every((line) => visibleWidth(line) === width));
	}

	editor.setText(Array.from({ length: 20 }, (_value, index) => `line ${index + 1}`).join("\n"));
	assert.match(stripAnsi(editor.render(48)[0] ?? ""), /^╭─ ⠋ Working · 12s ─── ↑ \d+ more ─+╮$/);

	editor.setWorkingStatusIndicator(undefined);
	editor.setText("");
	assert.equal(stripAnsi(editor.render(32)[0] ?? ""), `╭${"─".repeat(30)}╮`);
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
