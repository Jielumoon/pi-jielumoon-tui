import assert from "node:assert/strict";
import test from "node:test";
import { hasNerdFonts, resolveIcons } from "../src/footer/types.ts";

test("Footer 默认图标集合使用宽度稳定的 Unicode 字符", () => {
	const icons = resolveIcons(false);
	assert.equal(icons.path, "✧");
	assert.equal(icons.model, "π");
});

test("显式启用 Nerd Font 时保留原图标集合", () => {
	const icons = resolveIcons(true);
	assert.equal(icons.path.codePointAt(0), 0xf018b);
	assert.equal(icons.model.codePointAt(0), 0xf0768);
});

test("未显式声明时不猜测终端支持 Nerd Font", () => {
	const previous = process.env.POWERLINE_NERD_FONTS;
	delete process.env.POWERLINE_NERD_FONTS;
	try {
		assert.equal(hasNerdFonts(), false);
	} finally {
		if (previous === undefined) delete process.env.POWERLINE_NERD_FONTS;
		else process.env.POWERLINE_NERD_FONTS = previous;
	}
});
