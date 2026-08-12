/** 跨模块共享的运行时类型判断。命名区分“是否含数组 / 是否含函数”。 */

/** 对象或函数——可以作 WeakMap 键、可挂 Symbol 属性的值。 */
export function isObjectLike(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

/** 非 null 的 object，数组也通过（JSON 解析场景下调用方自行分辨数组）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object";
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

/** 排除数组的普通对象——认证凭证、API payload 等严格记录形状。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asPlainRecord(value: unknown): Record<string, unknown> | undefined {
	return isPlainRecord(value) ? value : undefined;
}
