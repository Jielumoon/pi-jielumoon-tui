import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PATCH_SCRIPT = path.join(REPO_ROOT, "scripts", "patch-pi-tui-flicker.mjs");
const PATCH_MARKER = "pi-jielumoon patch: skip stable non-image rows";

const SUPPORTED_SOURCE = `const isImageLine = (line) => line === "image";

export function render(newLines, previousLines) {
\tlet buffer = "";
\tconst firstChanged = 0;
\tconst lastChanged = newLines.length - 1;
        const renderEnd = Math.min(lastChanged, newLines.length - 1);
        for (let i = firstChanged; i <= renderEnd; i++) {
            if (i > firstChanged)
                buffer += "\\r\\n";
            const line = newLines[i];
            const isImage = isImageLine(line);
            const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
\t\tbuffer += imageReservedRows > 1 ? "image:" : line;
\t}
\treturn { buffer, previousLines };
}
`;

interface Fixture {
	backupDir: string;
	root: string;
	target: string;
}

async function createFixture(source = SUPPORTED_SOURCE): Promise<Fixture> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-tui-flicker-patch-"));
	const packageRoot = path.join(root, "pi-tui");
	const target = path.join(packageRoot, "dist", "tui-main-screen.js");
	const backupDir = path.join(root, "backups");
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(path.join(packageRoot, "package.json"), '{"name":"@earendil-works/pi-tui","version":"0.84.2","type":"module"}\n');
	await writeFile(target, source);
	await chmod(target, 0o755);
	return { backupDir, root, target };
}

function runPatch(fixture: Fixture, ...args: string[]) {
	return runPatchTarget(fixture, fixture.target, ...args);
}

function runPatchTarget(fixture: Fixture, target: string, ...args: string[]) {
	return spawnSync(process.execPath, [
		PATCH_SCRIPT,
		"--target",
		target,
		"--backup-dir",
		fixture.backupDir,
		...args,
	], { encoding: "utf8" });
}

test("check mode reports an applicable source without writing", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const before = await readFile(fixture.target, "utf8");

	const result = runPatch(fixture, "--check");

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /可应用/);
	assert.equal(await readFile(fixture.target, "utf8"), before);
	await assert.rejects(readdir(fixture.backupDir), { code: "ENOENT" });
});

test("apply is atomic, backed up, and idempotent", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const originalMode = (await stat(fixture.target)).mode & 0o777;

	const first = runPatch(fixture);
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stdout, /补丁已应用/);
	const patched = await readFile(fixture.target, "utf8");
	assert.match(patched, new RegExp(PATCH_MARKER));
	assert.match(patched, /line === this\.previousLines\[i\]/);
	assert.equal((await stat(fixture.target)).mode & 0o777, originalMode);


	type PatchedRender = (
		this: { getKittyImageReservedRows: () => number; previousLines: string[] },
		newLines: string[],
		previousLines: string[],
	) => { buffer: string };
	const patchedRender = (await import(`${pathToFileURL(fixture.target).href}?behavior`)).render as PatchedRender;
	const rendererContext = { getKittyImageReservedRows: () => 2, previousLines: [] as string[] };
	const renderPatched = (newLines: string[], previousLines: string[]) => {
		rendererContext.previousLines = previousLines;
		return patchedRender.call(rendererContext, newLines, previousLines);
	};
	assert.equal(renderPatched(["same"], ["same"]).buffer, "");
	assert.equal(renderPatched(["changed"], ["same"]).buffer, "changed");
	assert.match(renderPatched(["image"], ["image"]).buffer, /image:/);

	const backupsAfterFirstRun = await readdir(fixture.backupDir);
	assert.equal(backupsAfterFirstRun.length, 1);
	assert.equal(await readFile(path.join(fixture.backupDir, backupsAfterFirstRun[0]!), "utf8"), SUPPORTED_SOURCE);

	const second = runPatch(fixture);
	assert.equal(second.status, 0, second.stderr);
	assert.match(second.stdout, /已经应用/);
	assert.equal(await readFile(fixture.target, "utf8"), patched);
	assert.deepEqual(await readdir(fixture.backupDir), backupsAfterFirstRun);
});

test("unknown upstream source is rejected without a backup or write", async (t) => {
	const unsupportedSource = "export const changedUpstream = true;\n";
	const fixture = await createFixture(unsupportedSource);
	t.after(() => rm(fixture.root, { recursive: true, force: true }));

	const result = runPatch(fixture);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /拒绝修改/);
	assert.equal(await readFile(fixture.target, "utf8"), unsupportedSource);
	await assert.rejects(readdir(fixture.backupDir), { code: "ENOENT" });
});

test("a short anchor outside the verified loop is rejected", async (t) => {
	const misleadingSource = `export function unrelated(newLines) {
            const line = newLines[i];
            const isImage = isImageLine(line);
	return { line, isImage };
}
`;
	const fixture = await createFixture(misleadingSource);
	t.after(() => rm(fixture.root, { recursive: true, force: true }));

	const result = runPatch(fixture);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /拒绝修改/);
	assert.equal(await readFile(fixture.target, "utf8"), misleadingSource);
});

test("an explicit JavaScript target must be the package regular renderer", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const wrongTarget = path.join(path.dirname(fixture.target), "other-renderer.js");
	await writeFile(wrongTarget, SUPPORTED_SOURCE);

	const result = runPatchTarget(fixture, wrongTarget);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /tui-main-screen\.js/);
	assert.equal(await readFile(wrongTarget, "utf8"), SUPPORTED_SOURCE);
});

test("an existing target lock prevents concurrent writes", async (t) => {
	const fixture = await createFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const lockPath = `${fixture.target}.pi-jielumoon.lock`;
	await writeFile(lockPath, "another-process\n");

	const result = runPatch(fixture);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /补丁进程或残留锁/);
	assert.equal(await readFile(fixture.target, "utf8"), SUPPORTED_SOURCE);
});
