#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const TARGET_SUFFIX = path.join(
	"@earendil-works",
	"pi-coding-agent",
	"node_modules",
	"@earendil-works",
	"pi-tui",
	"dist",
	"tui-main-screen.js",
);
const PATCH_MARKER = "pi-jielumoon patch: skip stable non-image rows";
const SOURCE_ANCHOR = `        const renderEnd = Math.min(lastChanged, newLines.length - 1);
        for (let i = firstChanged; i <= renderEnd; i++) {
            if (i > firstChanged)
                buffer += "\\r\\n";
            const line = newLines[i];
            const isImage = isImageLine(line);
            const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;`;
const PATCHED_ANCHOR = `        const renderEnd = Math.min(lastChanged, newLines.length - 1);
        for (let i = firstChanged; i <= renderEnd; i++) {
            if (i > firstChanged)
                buffer += "\\r\\n";
            const line = newLines[i];
            const isImage = isImageLine(line);
            // ${PATCH_MARKER}
            if (line === this.previousLines[i] && !isImage) {
                continue;
            }
            const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;`;
const DEFAULT_BACKUP_DIR = path.join(homedir(), ".pi", "agent", "patch-backups", "pi-tui");

function readOptionValue(args, index, option) {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${option} 缺少路径参数`);
	return value;
}

function parseArgs(args) {
	const options = { backupDir: DEFAULT_BACKUP_DIR, check: false, help: false, target: undefined };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--check") options.check = true;
		else if (arg === "--help" || arg === "-h") options.help = true;
		else if (arg === "--target") {
			options.target = readOptionValue(args, index, arg);
			index++;
		}
		else if (arg === "--backup-dir") {
			options.backupDir = readOptionValue(args, index, arg);
			index++;
		}
		else throw new Error(`未知参数：${arg}`);
	}
	return options;
}

function addPrefixRoot(roots, prefix) {
	if (prefix) roots.push(path.resolve(prefix, "lib", "node_modules"));
}

function discoverGlobalRoots() {
	const roots = [];
	addPrefixRoot(roots, process.env.npm_config_prefix);
	addPrefixRoot(roots, process.env.NPM_CONFIG_PREFIX);
	addPrefixRoot(roots, process.env.PI_NPM_PREFIX);
	addPrefixRoot(roots, path.join(homedir(), ".npm-global"));
	const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8" });
	if (npmRoot.status === 0 && npmRoot.stdout.trim()) roots.push(path.resolve(npmRoot.stdout.trim()));
	return [...new Set(roots)];
}

function normalizeExplicitTarget(target) {
	const resolved = path.resolve(target);
	const candidate = resolved.endsWith(".js") ? resolved : path.join(resolved, "dist", "tui-main-screen.js");
	if (path.basename(candidate) !== "tui-main-screen.js" || path.basename(path.dirname(candidate)) !== "dist") {
		throw new Error("--target 必须指向 pi-tui 包目录或其 dist/tui-main-screen.js");
	}
	return candidate;
}

function candidateTargets(explicitTarget) {
	if (explicitTarget) return [normalizeExplicitTarget(explicitTarget)];
	const targets = [];
	if (process.env.PI_TUI_MAIN_SCREEN) targets.push(path.resolve(process.env.PI_TUI_MAIN_SCREEN));
	for (const root of discoverGlobalRoots()) targets.push(path.join(root, TARGET_SUFFIX));
	return [...new Set(targets)];
}

async function isFile(filePath) {
	try {
		return (await stat(filePath)).isFile();
	}
	catch {
		return false;
	}
}

async function locateTarget(explicitTarget) {
	const candidates = candidateTargets(explicitTarget);
	const matches = [];
	for (const candidate of candidates) {
		if (await isFile(candidate)) matches.push(candidate);
	}
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		throw new Error(`发现多个 Pi TUI 安装，请用 --target 明确指定：\n${matches.map((item) => `  - ${item}`).join("\n")}`);
	}
	throw new Error(`找不到 Pi TUI regular renderer。已检查：\n${candidates.map((item) => `  - ${item}`).join("\n")}`);
}

async function readPackageVersion(target) {
	const packageRoot = path.resolve(path.dirname(target), "..");
	const expectedTarget = path.join(packageRoot, "dist", "tui-main-screen.js");
	if (path.resolve(target) !== expectedTarget) throw new Error(`目标路径无效：${target}`);
	const packagePath = path.join(packageRoot, "package.json");
	const metadata = JSON.parse(await readFile(packagePath, "utf8"));
	if (metadata.name !== "@earendil-works/pi-tui" || typeof metadata.version !== "string") {
		throw new Error(`目标不属于有效的 @earendil-works/pi-tui 包：${packagePath}`);
	}
	return metadata.version;
}

function countOccurrences(source, needle) {
	let count = 0;
	let offset = 0;
	while ((offset = source.indexOf(needle, offset)) !== -1) {
		count++;
		offset += needle.length;
	}
	return count;
}

function inspectSource(source) {
	const markerCount = countOccurrences(source, PATCH_MARKER);
	if (markerCount === 1 && source.includes(PATCHED_ANCHOR)) return "patched";
	if (markerCount > 0) return "unsupported";
	return countOccurrences(source, SOURCE_ANCHOR) === 1 ? "applicable" : "unsupported";
}

function checkSyntax(filePath) {
	const result = spawnSync(process.execPath, ["--check", filePath], { encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`补丁后的 JavaScript 语法校验失败：\n${result.stderr.trim()}`);
}

function backupFileName(version, source) {
	const hash = createHash("sha256").update(source).digest("hex").slice(0, 12);
	const safeVersion = version.replace(/[^0-9A-Za-z._-]/g, "_");
	return `pi-tui-${safeVersion}-${hash}-tui-main-screen.js`;
}

async function createBackup(backupDir, version, source, mode) {
	await mkdir(backupDir, { recursive: true, mode: 0o700 });
	const backupPath = path.join(backupDir, backupFileName(version, source));
	try {
		const handle = await open(backupPath, "wx", mode);
		try {
			await handle.writeFile(source);
			await handle.sync();
		}
		finally {
			await handle.close();
		}
	}
	catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
		if (await readFile(backupPath, "utf8") !== source) throw new Error(`备份文件冲突：${backupPath}`);
	}
	return backupPath;
}

async function withTargetLock(target, run) {
	const lockPath = `${target}.pi-jielumoon.lock`;
	let handle;
	try {
		handle = await open(lockPath, "wx", 0o600);
	}
	catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
			throw new Error(`检测到另一个补丁进程或残留锁：${lockPath}`);
		}
		throw error;
	}
	try {
		await handle.writeFile(`${process.pid}\n`);
		return await run();
	}
	finally {
		try {
			await handle.close();
		}
		finally {
			await rm(lockPath, { force: true });
		}
	}
}

async function assertTargetUnchanged(target, source) {
	if (await readFile(target, "utf8") !== source) {
		throw new Error("写入前检测到目标文件发生变化，已停止；请重新运行脚本");
	}
}

async function writeTemporaryFile(filePath, source, mode) {
	const handle = await open(filePath, "wx", mode);
	try {
		await handle.writeFile(source, "utf8");
		await handle.sync();
	}
	finally {
		await handle.close();
	}
}

async function restoreTargetIfAbsent(source, target) {
	try {
		await link(source, target);
	}
	catch (error) {
		if (error?.code === "EEXIST") return;
		throw error;
	}
	await rm(source, { force: true });
}

async function replaceTargetWithoutOverwrite(target, temporaryPath, source) {
	const stagingDir = await mkdtemp(path.join(path.dirname(target), ".pi-jielumoon-target-"));
	const originalPath = path.join(stagingDir, "original.js");
	try {
		await rename(target, originalPath);
		if (await readFile(originalPath, "utf8") !== source) {
			await restoreTargetIfAbsent(originalPath, target);
			throw new Error("写入前检测到目标文件发生变化，已停止；请重新运行脚本");
		}
		try {
			await link(temporaryPath, target);
		}
		catch (error) {
			await restoreTargetIfAbsent(originalPath, target);
			throw new Error("替换期间检测到目标文件发生变化，已停止；请重新运行脚本", { cause: error });
		}
	}
	finally {
		await rm(stagingDir, { recursive: true, force: true });
	}
}

async function applyPatch(target, backupDir, version, source) {
	const targetStat = await stat(target);
	const mode = targetStat.mode & 0o777;
	const temporaryPath = `${target}.pi-jielumoon-${process.pid}-${Date.now()}.tmp.js`;
	const patchedSource = source.replace(SOURCE_ANCHOR, PATCHED_ANCHOR);
	try {
		await writeTemporaryFile(temporaryPath, patchedSource, mode);
		checkSyntax(temporaryPath);
		await chmod(temporaryPath, mode);
		await assertTargetUnchanged(target, source);
		const backupPath = await createBackup(backupDir, version, source, mode);
		await assertTargetUnchanged(target, source);
		await replaceTargetWithoutOverwrite(target, temporaryPath, source);
		return backupPath;
	}
	finally {
		await rm(temporaryPath, { force: true });
	}
}

function printHelp() {
	console.log(`用法：node scripts/patch-pi-tui-flicker.mjs [选项]

选项：
  --check              只检查，不修改文件
  --target <路径>      指定 pi-tui 包目录或 tui-main-screen.js
  --backup-dir <路径>  指定持久备份目录
  -h, --help           显示帮助`);
}

async function processTarget(options, target) {
	const version = await readPackageVersion(target);
	const source = await readFile(target, "utf8");
	const state = inspectSource(source);
	console.log(`Pi TUI：${version}`);
	console.log(`目标：${target}`);
	if (state === "patched") return console.log("状态：补丁已经应用，无需重复修改。");
	if (state === "unsupported") {
		throw new Error("拒绝修改：上游源码结构与已验证版本不一致；请更新补丁脚本后再运行。");
	}
	if (options.check) return console.log("状态：补丁可应用；本次 --check 未写入文件。");
	const backupPath = await applyPatch(target, path.resolve(options.backupDir), version, source);
	console.log("状态：补丁已应用。稳定的非图片行将不再被清空重写。");
	console.log(`备份：${backupPath}`);
	console.log("提示：已运行的 Pi 进程不会热加载此文件，请新开 Pi 会话验证。");
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) return printHelp();
	const target = await locateTarget(options.target);
	if (options.check) return processTarget(options, target);
	return withTargetLock(target, () => processTarget(options, target));
}

main().catch((error) => {
	console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
