/** write / edit 参数流逐字动画共享的推进策略与全局调度器。 */

import { visibleWidth } from "@earendil-works/pi-tui";

const STREAM_ANIMATION_INTERVAL_MS = 40;
const STREAM_ANIMATION_MAX_STEP = 64;
const STREAM_ANIMATION_CATCHUP_TICKS = 6;

/** 参与共享 tick 的流式动画组件。 */
export type StreamAnimatable = {
	advanceAnimation(): boolean;
	stop(): void;
};

export function commonPrefixBoundary(left: string, right: string): number {
	const max = Math.min(left.length, right.length);
	let index = 0;
	while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) index++;
	if (index > 0) {
		const previous = left.charCodeAt(index - 1);
		if (previous >= 0xd800 && previous <= 0xdbff) index--;
	}
	return index;
}

function advanceCodePoints(value: string, offset: number, count: number): number {
	let next = Math.max(0, Math.min(offset, value.length));
	for (let advanced = 0; advanced < count && next < value.length; advanced++) {
		const codePoint = value.codePointAt(next);
		next += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
	}
	return next;
}

/** 纯推进策略，供组件与确定性测试共用。 */
export function advanceStreamReveal(current: string, target: string): string {
	if (current === target) return target;
	let prefixLength = current.length;
	if (!target.startsWith(current)) prefixLength = commonPrefixBoundary(current, target);
	const backlog = Math.max(0, target.length - prefixLength);
	const step = Math.min(
		STREAM_ANIMATION_MAX_STEP,
		Math.max(1, Math.ceil(backlog / STREAM_ANIMATION_CATCHUP_TICKS)),
	);
	return target.slice(0, advanceCodePoints(target, prefixLength, step));
}

/** 取按可见宽度截尾的后缀；用于折叠态限制超长单行的换行成本。 */
export function trailingTextByWidth(value: string, width: number): string {
	if (width <= 0 || value.length === 0) return "";
	const sourceLimit = Math.max(1_024, width * 4);
	let suffixStart = Math.max(0, value.length - sourceLimit);
	const firstCode = value.charCodeAt(suffixStart);
	if (suffixStart > 0 && firstCode >= 0xdc00 && firstCode <= 0xdfff) suffixStart--;
	const suffix = Array.from(value.slice(suffixStart));
	let low = 0;
	let high = suffix.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (visibleWidth(suffix.slice(middle).join("")) > width) low = middle + 1;
		else high = middle;
	}
	return suffix.slice(low).join("");
}

const activeStreamAnimations = new Set<StreamAnimatable>();
let streamAnimationTimer: ReturnType<typeof setInterval> | undefined;

function stopStreamAnimationTimerIfIdle(): void {
	if (activeStreamAnimations.size > 0 || streamAnimationTimer === undefined) return;
	clearInterval(streamAnimationTimer);
	streamAnimationTimer = undefined;
}

export function scheduleStreamAnimation(component: StreamAnimatable): void {
	activeStreamAnimations.add(component);
	if (streamAnimationTimer !== undefined) return;
	streamAnimationTimer = setInterval(() => {
		for (const active of [...activeStreamAnimations]) {
			try {
				if (!active.advanceAnimation()) activeStreamAnimations.delete(active);
			} catch {
				active.stop();
				activeStreamAnimations.delete(active);
			}
		}
		stopStreamAnimationTimerIfIdle();
	}, STREAM_ANIMATION_INTERVAL_MS);
	streamAnimationTimer.unref?.();
}

export function unscheduleStreamAnimation(component: StreamAnimatable): void {
	activeStreamAnimations.delete(component);
	stopStreamAnimationTimerIfIdle();
}

export function stopAllStreamAnimations(): void {
	for (const component of [...activeStreamAnimations]) component.stop();
	activeStreamAnimations.clear();
	stopStreamAnimationTimerIfIdle();
}
