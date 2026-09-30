/** 只读语法预览：恢复半截参数，不执行表达式或预测控制流。 */
import { parse as parseStrict, parseExpressionAt } from "acorn";
import { parse as parseLoose } from "acorn-loose";
import { parseStreamingJson } from "@earendil-works/pi-ai";
import { asPlainRecord } from "../guards.ts";

function parseSource(source: string) {
	const options = { ecmaVersion: "latest" as const, sourceType: "module" as const, allowReturnOutsideFunction: true };
	try {
		return parseStrict(source, options);
	} catch {
		return parseLoose(source, options);
	}
}

/** loose 的未闭合字符串保留字面转义；补齐引号后交给 Acorn 解码，不执行表达式。 */
function stringValue(raw: string): string | undefined {
	const quote = raw[0];
	const escape = raw.lastIndexOf("\\");
	for (const candidate of [raw, raw + quote, ...(escape >= 0 ? [raw.slice(0, escape) + quote] : [])]) {
		try {
			const node = parseExpressionAt(candidate, 0, { ecmaVersion: "latest" });
			if (node.type === "Literal" && node.end === candidate.length && typeof node.value === "string") return node.value;
		} catch {
			// 尾部转义尚未生成完整时只保留它之前的字符串。
		}
	}
	return undefined;
}

function objectArgs(value: unknown, source: string): Record<string, unknown> | undefined {
	const node = asPlainRecord(value);
	if (node?.type !== "ObjectExpression" || !Array.isArray(node.properties)) return undefined;
	const result: Record<string, unknown> = Object.create(null);
	for (const item of node.properties) {
		const property = asPlainRecord(item);
		const key = asPlainRecord(property?.key);
		const field = asPlainRecord(property?.value);
		if (property?.type !== "Property" || property.computed || property.method || property.kind !== "init" || !field) continue;
		const name = key?.name ?? key?.value;
		if (typeof name !== "string" || field.name === "✖") continue;
		const raw = source.slice(Number(field.start), Number(field.end));
		if (field.type === "Literal" && (raw.startsWith('"') || raw.startsWith("'"))) {
			const decoded = stringValue(raw);
			if (decoded !== undefined) result[name] = decoded;
			continue;
		}
		result[name] = field.type === "Literal" && (field.value === null || ["string", "number", "boolean"].includes(typeof field.value))
			? field.value : raw;
	}
	return result;
}

/** 宿主 args 最多 200 字符；JSON 被截断时仍能恢复已有的 command/path 字段。 */
export function parseCodemodeArgs(raw: string): Record<string, unknown> | undefined {
	return asPlainRecord(parseStreamingJson(raw));
}

export function previewCodemodeCalls(source: string) {
	const calls: { name: string; args: string; status: "preview"; start: number }[] = [];
	try {
		const tree = parseSource(source);
		const visit = (value: unknown): void => {
			if (Array.isArray(value)) { value.forEach(visit); return; }
			const node = asPlainRecord(value);
			if (!node) return;
			const callee = asPlainRecord(node.callee);
			const object = asPlainRecord(callee?.object);
			const property = asPlainRecord(callee?.property);
			if (node.type === "CallExpression" && callee?.type === "MemberExpression" && !callee.computed
				&& object?.type === "Identifier" && object.name === "tools" && property?.type === "Identifier" && property.name !== "✖") {
				const first = Array.isArray(node.arguments) ? node.arguments[0] : undefined;
				const args = objectArgs(first, source);
				calls.push({
					name: String(property.name),
					args: args ? JSON.stringify(args) : first ? source.slice(Number(asPlainRecord(first)?.start), Number(asPlainRecord(first)?.end)) : "",
					status: "preview",
					start: Number(node.start),
				});
			}
			Object.values(node).forEach(visit);
		};
		visit(tree);
	} catch {
		// 语法恢复失败时不猜测子调用，保留父标题与可展开的原脚本。
	}
	return calls.sort((a, b) => a.start - b.start);
}
