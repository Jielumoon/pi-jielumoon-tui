/**
 * 时长/时刻格式化集合。四个函数面向不同 UI 场景，输出风格刻意不同，
 * 新需求先看这里有没有合适的，避免再造第五个。
 */

/** Footer 会话时长：`1h2m` / `3m5s` / `42s`，向下取整、无空格。 */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m${seconds % 60}s`;
	return `${seconds}s`;
}

/** Working transcript：`1m 5s` / `7s`，分秒之间带空格，最长到分钟。 */
export function formatElapsed(milliseconds: number): string {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Blackhole 冷却：向上取整到分钟，`45m` / `1h5m` / `2h`，永不显示秒。 */
export function formatCooldownDuration(ms: number): string {
	const minutes = Math.max(1, Math.ceil(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder > 0 ? `${hours}h${remainder}m` : `${hours}h`;
}

/** 订阅额度重置：基于绝对时间戳的粗粒度倒计时，`now` / `59m` / `23h` / `3d`。 */
export function formatUsageReset(resetAt: string | undefined, now = Date.now()): string | undefined {
	if (!resetAt) return undefined;
	const time = Date.parse(resetAt);
	if (Number.isNaN(time)) return undefined;
	const diff = time - now;
	if (diff <= 0) return "now";
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}
