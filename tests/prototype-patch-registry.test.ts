import assert from "node:assert/strict";
import test from "node:test";
import {
	installPrototypePatch,
	ZENTUI_PROTOTYPE_PATCH_REGISTRY,
} from "../src/prototype-patch-registry.ts";

type Target = { render: (...args: unknown[]) => unknown };

function makeTarget(): Target {
	return {
		render: (...args: unknown[]) => `base:${args.join(",")}`,
	};
}

test("patch wraps the method and cleanup restores the predecessor", () => {
	const target = makeTarget();
	const original = target.render;
	const cleanup = installPrototypePatch(target, "render", "user-message-render", ({ predecessor, receiver, args }) => {
		return `patched:${Reflect.apply(predecessor, receiver, args)}`;
	});

	assert.equal(target.render("a"), "patched:base:a", "behavior should wrap the predecessor");
	assert.ok(Reflect.has(target, ZENTUI_PROTOTYPE_PATCH_REGISTRY), "registry symbol should be attached while patched");

	cleanup();
	assert.equal(target.render, original, "cleanup should restore the original method");
	assert.ok(!Reflect.has(target, ZENTUI_PROTOTYPE_PATCH_REGISTRY), "empty registry should be detached");

	cleanup();
	assert.equal(target.render, original, "double cleanup must stay a no-op");
});

test("reinstalling the same adapter reuses the wrapper and hands over the behavior", () => {
	const target = makeTarget();
	const cleanupFirst = installPrototypePatch(target, "render", "user-message-render", () => "first");
	const wrapper = target.render;

	const cleanupSecond = installPrototypePatch(target, "render", "user-message-render", () => "second");
	assert.equal(target.render, wrapper, "same adapter should not stack a second wrapper");
	assert.equal(target.render(), "second", "latest registration wins");

	cleanupFirst();
	assert.equal(target.render(), "second", "stale cleanup must not remove the active registration");

	cleanupSecond();
	assert.equal(target.render(), "base:", "active cleanup restores the predecessor");
});

test("cleanup leaves foreign overrides in place", () => {
	const target = makeTarget();
	const cleanup = installPrototypePatch(target, "render", "user-message-render", () => "patched");
	const foreign = (): string => "foreign";
	target.render = foreign;

	cleanup();
	assert.equal(target.render, foreign, "cleanup must not clobber a later foreign override");
});

test("patching a missing method throws instead of installing a broken wrapper", () => {
	const target = {} as Target;
	assert.throws(
		() => installPrototypePatch(target, "render", "user-message-render", () => undefined),
		TypeError,
		"non-function predecessor should be rejected",
	);
});

test("behavior receives the receiver and arguments unchanged", () => {
	const target = makeTarget();
	const seen: Array<{ receiver: unknown; args: unknown[] }> = [];
	const cleanup = installPrototypePatch(target, "render", "user-message-render", ({ predecessor, receiver, args }) => {
		seen.push({ receiver, args });
		return Reflect.apply(predecessor, receiver, args);
	});

	const detached = target.render;
	const host = { render: detached };
	host.render(1, "two");

	assert.equal(seen.length, 1, "behavior should run once per call");
	assert.equal(seen[0]?.receiver, host, "receiver must flow through untouched");
	assert.deepEqual(seen[0]?.args, [1, "two"], "arguments must flow through untouched");
	cleanup();
});
