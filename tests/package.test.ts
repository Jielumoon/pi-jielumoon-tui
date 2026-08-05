import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

test("package exposes one self-owned extension entry", () => {
	const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
		pi?: { extensions?: unknown };
	};

	assert.deepEqual(manifest.pi?.extensions, [
		"./src/index.ts",
		"./node_modules/@narumitw/pi-usage/src/index.ts",
	]);
});
