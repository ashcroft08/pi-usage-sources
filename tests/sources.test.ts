// Deterministic tests for the usage sources. No network, no real agy: the
// agy runner and the fetch function are injected.
//
// Fixtures are the real payloads captured on 2026-10-14:
//   - OpenCode Go: GET https://opencode.ai/zen/go/v1/usage
//   - Antigravity: `agy --print /usage --output-format json`
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildSources,
	mapAntigravityEnvelope,
	mapOpenCodeGo,
	USAGE_SOURCE_EVENT,
	USAGE_SOURCE_SCHEMA,
} from "../src/sources.ts";

const NOW = 1_792_000_000_000;

// The endpoint field is `resetsAt` (with the s). The PR under review read
// `resetAt`, which is exactly what these assertions pin.
const OPENCODE_GO_PAYLOAD = {
	usage: {
		rolling: { status: "ok", percent: 1, resetsAt: "2026-10-15T08:56:52.000Z" },
		weekly: { status: "ok", percent: 6, resetsAt: "2026-10-19T00:00:00.000Z" },
		monthly: { status: "ok", percent: 42, resetsAt: "2026-11-07T15:43:50.000Z" },
	},
};

// Shape of `agy --print /usage --output-format json`: nested under command.data,
// snake_case fields, and `remaining_fraction` (remaining, not used).
const AGY_ENVELOPE = {
	conversation_id: "",
	status: "SUCCESS",
	response: "Gemini Models\tWeekly Limit Remaining\t83%\t2026-10-21T02:39:39Z\n",
	command: {
		name: "usage",
		data: {
			groups: [
				{
					name: "Gemini Models",
					buckets: [
						{ id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.827693521976471, reset_time: "2026-10-21T02:39:39Z" },
						{ id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.9079331755638123, reset_time: "2026-10-15T05:26:37Z" },
					],
				},
				{
					name: "Claude and GPT models",
					buckets: [
						{ id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-22T04:14:40Z" },
						{ id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-10-15T09:14:40Z" },
					],
				},
			],
		},
	},
};

// What the CLI answers when a tool it needs was auto-denied (observed once).
const AGY_DENIAL_ENVELOPE = {
	conversation_id: "091e8312",
	status: "SUCCESS",
	response: "",
	denied_actions: [{ action: "command", display_name: "RunCommand" }],
};

test("mapOpenCodeGo maps the three windows with the endpoint's own percentages", () => {
	const usage = mapOpenCodeGo(OPENCODE_GO_PAYLOAD, NOW);
	assert.equal(usage?.provider, "opencode-go");
	assert.equal(usage?.plan, "Go");
	assert.equal(usage?.fetchedAt, NOW);
	assert.deepEqual(
		usage?.limits[0]?.windows.map((window) => [window.label, window.usedPercent, window.windowSeconds]),
		[
			["5h", 1, 18_000],
			["week", 6, 604_800],
			["month", 42, 2_592_000],
		],
	);
	assert.equal(usage?.limits[0]?.limitReached, false);
});

test("mapOpenCodeGo keeps every reset time (the resetsAt field)", () => {
	const windows = mapOpenCodeGo(OPENCODE_GO_PAYLOAD, NOW)?.limits[0]?.windows ?? [];
	assert.deepEqual(
		windows.map((window) => window.resetAt),
		[Date.parse("2026-10-15T08:56:52.000Z"), Date.parse("2026-10-19T00:00:00.000Z"), Date.parse("2026-11-07T15:43:50.000Z")],
	);
});

test("mapOpenCodeGo marks the plan exhausted at 100 percent", () => {
	const usage = mapOpenCodeGo({ usage: { weekly: { status: "ok", percent: 100 } } }, NOW);
	assert.equal(usage?.limits[0]?.limitReached, true);
	assert.equal(usage?.limits[0]?.windows.length, 1);
});

test("mapOpenCodeGo refuses an unusable payload", () => {
	assert.equal(mapOpenCodeGo(undefined, NOW), undefined);
	assert.equal(mapOpenCodeGo({}, NOW), undefined);
	assert.equal(mapOpenCodeGo({ usage: {} }, NOW), undefined);
	// A window whose status is not ok is not a percentage to render.
	assert.equal(mapOpenCodeGo({ usage: { rolling: { status: "error", percent: 10 } } }, NOW), undefined);
	// No account field is kept, whatever the payload carries.
	const usage = mapOpenCodeGo({ account: { email: "must-not-survive@example.com" }, usage: { rolling: { status: "ok", percent: 5 } } }, NOW);
	assert.doesNotMatch(JSON.stringify(usage), /must-not-survive|example\.com/);
});

test("mapAntigravityEnvelope inverts remaining fractions into used percentages", () => {
	const usage = mapAntigravityEnvelope(AGY_ENVELOPE, NOW);
	assert.equal(usage?.provider, "antigravity");
	assert.deepEqual(usage?.limits.map((limit) => limit.name), ["Gemini Models", "Claude and GPT models"]);
	const gemini = usage?.limits[0]?.windows ?? [];
	// 0.9079 remaining -> 9.2 used, 0.8277 remaining -> 17.23 used, sorted shortest window first.
	assert.deepEqual(gemini.map((window) => [window.label, window.windowSeconds]), [["5h", 18_000], ["week", 604_800]]);
	assert.ok(Math.abs((gemini[0]?.usedPercent ?? 0) - 9.20668) < 0.001, `5h used=${gemini[0]?.usedPercent}`);
	assert.ok(Math.abs((gemini[1]?.usedPercent ?? 0) - 17.23065) < 0.001, `week used=${gemini[1]?.usedPercent}`);
	assert.equal(gemini[0]?.resetAt, Date.parse("2026-10-15T05:26:37Z"));
	assert.equal(usage?.limits[1]?.limitReached, false);
});

test("mapAntigravityEnvelope refuses anything that is not a usable /usage result", () => {
	assert.equal(mapAntigravityEnvelope(undefined, NOW), undefined);
	assert.equal(mapAntigravityEnvelope(AGY_DENIAL_ENVELOPE, NOW), undefined);
	assert.equal(mapAntigravityEnvelope(AGY_ENVELOPE.command.data, NOW), undefined);
	assert.equal(mapAntigravityEnvelope({ status: "SUCCESS", command: { name: "other", data: { groups: [] } } }, NOW), undefined);
	assert.equal(mapAntigravityEnvelope({ status: "FAILURE", command: { name: "usage", data: { groups: [{ name: "g", buckets: [{ window: "weekly", remaining_fraction: 1 }] }] } } }, NOW), undefined);
});

test("buildSources exposes both providers under the contract the shell validates", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sources-"));
	const auth = path.join(dir, "auth.json");
	fs.writeFileSync(auth, JSON.stringify({ "opencode-go": { type: "api_key", key: "test-key" } }));
	const sources = buildSources({ env: { OPENCODE_GO_AUTH: auth }, runAgyJson: async () => JSON.stringify(AGY_ENVELOPE) });
	assert.deepEqual(sources.map((source) => source.provider), ["opencode-go", "antigravity"]);
	for (const source of sources) {
		assert.equal(source.schema, USAGE_SOURCE_SCHEMA);
		assert.equal(typeof source.fetch, "function");
		assert.equal(typeof source.pendingNote, "string");
	}

	const opencode = sources[0];
	let seen: { url: string; headers: Record<string, string> } | undefined;
	const usage = await opencode.fetch(undefined, async (input, init) => {
		seen = { url: String(input), headers: (init?.headers ?? {}) as Record<string, string> };
		return new Response(JSON.stringify(OPENCODE_GO_PAYLOAD), { status: 200 });
	}, NOW);
	assert.equal(usage?.limits[0]?.windows.length, 3);
	assert.equal(seen?.url, "https://opencode.ai/zen/go/v1/usage");
	assert.equal(seen?.headers.Authorization, "Bearer test-key");

	const antigravity = sources[1];
	const agyUsage = await antigravity.fetch(undefined, async () => new Response("{}"), NOW);
	assert.equal(agyUsage?.limits.length, 2);

	fs.rmSync(dir, { recursive: true, force: true });
});

test("the OpenCode Go source degrades to nothing without a credential or a bad response", async () => {
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sources-empty-"));
	const sources = buildSources({ env: { OPENCODE_GO_AUTH: path.join(empty, "missing.json") }, runAgyJson: async () => undefined });
	const opencode = sources[0];
	// No key at all: no request is attempted.
	assert.equal(await opencode.fetch(undefined, async () => new Response("{}", { status: 200 }), NOW), undefined);
	// A rejected key answers 401: nothing to render.
	const unauthorized = buildSources({ env: { OPENCODE_GO_AUTH: path.join(empty, "auth.json") } });
	fs.writeFileSync(path.join(empty, "auth.json"), JSON.stringify({ "opencode-go": { key: "bad" } }));
	assert.equal(await unauthorized[0].fetch(undefined, async () => new Response("nope", { status: 401 }), NOW), undefined);
	// A thrown fetch never escapes.
	assert.equal(await unauthorized[0].fetch(undefined, async () => { throw new Error("network"); }, NOW), undefined);
	// The agy source with no runner output is nothing to render either.
	assert.equal(await sources[1].fetch(undefined, async () => new Response("{}"), NOW), undefined);
	fs.rmSync(empty, { recursive: true, force: true });
});

test("the extension registers both sources now and again on every session start", async () => {
	const emitted: Array<{ name: string; payload: { provider: string } }> = [];
	const handlers: Array<() => void> = [];
	const fakePi = {
		events: { emit: (name: string, payload: unknown) => emitted.push({ name, payload: payload as { provider: string } }) },
		on: (event: string, handler: () => void) => {
			if (event === "session_start") handlers.push(handler);
		},
	};
	const extensionModule = await import("../extensions/usage-sources.ts");
	extensionModule.default(fakePi as never);
	assert.deepEqual(
		emitted.map((entry) => entry.payload.provider),
		["opencode-go", "antigravity"],
	);
	assert.ok(emitted.every((entry) => entry.name === USAGE_SOURCE_EVENT));
	assert.equal(handlers.length, 1);
	// A second session re-registers the same two providers; the shell replaces them.
	handlers[0]?.();
	assert.equal(emitted.length, 4);
});
