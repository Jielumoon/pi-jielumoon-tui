/**
 * apply_patch（@xl0/pi-lovely-codex）的补丁解析：信封路径提取 +
 * unified diff 文本 → DiffData。纯函数，不产渲染。
 */

import type { DiffData, DiffEntry } from "./diff.ts";

export type PatchFileDiff = {
	path: string;
	diffData: DiffData;
};

const ENVELOPE_FILE_RE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** 从 `*** Begin Patch` 信封提取触碰路径（含 `*** Move to:` 目标，按出现顺序去重）。 */
export function parsePatchEnvelopePaths(input: string): string[] {
	const paths: string[] = [];
	for (const line of input.replace(/\r\n/g, "\n").split("\n")) {
		const path = ENVELOPE_FILE_RE.exec(line)?.[1]?.trim();
		if (path && !paths.includes(path)) paths.push(path);
	}
	return paths;
}

/** 去掉 git 风格 a//b/ 前缀；pi 的 generateUnifiedPatch（FILE_HEADERS_ONLY）不产时间戳。 */
function stripDiffPathPrefix(path: string): string {
	return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

type PatchFileBuilder = {
	path: string;
	entries: DiffEntry[];
	added: number;
	removed: number;
	context: number;
	oldLine: number;
	newLine: number;
	/** 当前 hunk 的剩余行数配额；双零表示不在 hunk 内，此时 `--- `/`+++ ` 才是文件头。 */
	pendingOld: number;
	pendingNew: number;
};

/**
 * 解析标准 unified diff（pi `generateUnifiedPatch` 产出的 `--- / +++ / @@` 文本，多文件顺序拼接）。
 * 用 `@@ -a,b +c,d @@` 声明的行数做配额：hunk 激活期间 `--- x`/`+++ x` 是内容行
 * （被删的 `-- x` 会编码成 `-` + `-- x`），配额归零后才回到文件头状态。
 */
export function parseUnifiedPatch(text: string): PatchFileDiff[] {
	const files: PatchFileDiff[] = [];
	let current: PatchFileBuilder | undefined;
	const flush = () => {
		if (current && current.added + current.removed > 0) {
			files.push({
				path: current.path,
				diffData: {
					version: 1,
					entries: current.entries,
					stats: {
						added: current.added,
						removed: current.removed,
						context: current.context,
					},
				},
			});
		}
		current = undefined;
	};

	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		if (current && (current.pendingOld > 0 || current.pendingNew > 0)) {
			if (line.startsWith("+")) {
				current.entries.push({ kind: "add", newLine: current.newLine++, text: line.slice(1) });
				current.added += 1;
				current.pendingNew -= 1;
			} else if (line.startsWith("-")) {
				current.entries.push({ kind: "remove", oldLine: current.oldLine++, text: line.slice(1) });
				current.removed += 1;
				current.pendingOld -= 1;
			} else if (line.startsWith(" ")) {
				current.entries.push({
					kind: "context",
					oldLine: current.oldLine++,
					newLine: current.newLine++,
					text: line.slice(1),
					});
				current.context += 1;
				current.pendingOld -= 1;
				current.pendingNew -= 1;
			}
			// `\ No newline at end of file` 不消耗配额。
			continue;
		}
		if (line.startsWith("--- ")) {
			flush();
			current = {
				path: stripDiffPathPrefix(line.slice(4)),
				entries: [],
				added: 0,
				removed: 0,
				context: 0,
				oldLine: 1,
				newLine: 1,
				pendingOld: 0,
				pendingNew: 0,
			};
			continue;
		}
		if (line.startsWith("+++ ")) {
			if (current) current.path = stripDiffPathPrefix(line.slice(4));
			continue;
		}
		const hunk = HUNK_HEADER_RE.exec(line);
		if (hunk && current) {
			current.oldLine = Number(hunk[1]);
			current.newLine = Number(hunk[3]);
			current.pendingOld = Number(hunk[2] ?? 1);
			current.pendingNew = Number(hunk[4] ?? 1);
		}
		// 多文件拼接产生的空行与其他杂行忽略。
	}
	flush();
	return files;
}
