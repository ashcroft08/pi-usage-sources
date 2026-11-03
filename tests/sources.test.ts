// Deterministic tests for the usage sources. No network, no real agy: the
// agy runner and the fetch function are injected.
//
// Fixtures are the real payloads captured on 2026-10-14:
//   - OpenCode Go: GET https://opencode.ai/zen/go/v1/usage
//   - Antigravity: `agy --print /usage --output-format json`
// and on 2026-10-15:
//   - Claude: `claude --print --verbose --output-format stream-json` (CLI
//     2.1.301), the `rate_limit_event` the bridge rebuilds its headers from.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	buildSources,
	CLAUDE_BRIDGE_PROVIDER,
	createClaudeBridgeSource,
	mapAntigravityEnvelope,
	mapClaudeBridgeHeaders,
	mapOpenCodeGo,
	readClaudePlan,
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

// The real `rate_limit_info` from the CLI's stream-json output. `utilization`
// is a fraction and `resetsAt` is Unix seconds, which is what the bridge's
// headers carry: it maps `unifiedWindows` to `anthropic-ratelimit-unified-*`.
const CLAUDE_RATE_LIMIT_INFO = {
	status: "allowed",
	resetsAt: 1792131600,
	rateLimitType: "five_hour",
	overageStatus: "rejected",
	overagedDisabledReason: "org_level_disabled",
	isUsingOverage: false,
	unifiedWindows: {
		five_hour: { utilization: 0, resetsAt: 1792131600 },
		seven_day: { utilization: 0, resetsAt: 1792375200 },
	},
};

// Exactly the headers pi-claude-bridge's rateLimitResponse builds from the
// payload above (five_hour -> 5h, seven_day -> 7d).
const CLAUDE_HEADERS: Record<string, string> = {
	"anthropic-ratelimit-unified-status": "allowed",
	"anthropic-ratelimit-unified-reset": "1792131600",
	"anthropic-ratelimit-unified-representative-claim": "five_hour",
	"anthropic-ratelimit-unified-overage-status": "rejected",
	"anthropic-ratelimit-unified-5h-utilization": "0",
	"anthropic-ratelimit-unified-5h-reset": "1792131600",
	"anthropic-ratelimit-unified-7d-utilization": "0",
	"anthropic-ratelimit-unified-7d-reset": "1792375200",
};

// The same header set observed live for a real bridge turn
// (`pi -p --model claude-bridge/claude-haiku-4-5` with a probe on this event):
// 8 unified headers, 5h at 0.04 and 7d at 0.
const CLAUDE_LIVE_HEADERS: Record<string, string> = {
	"anthropic-ratelimit-unified-status": "allowed",
	"anthropic-ratelimit-unified-reset": "1792131600",
	"anthropic-ratelimit-unified-representative-claim": "five_hour",
	"anthropic-ratelimit-unified-overage-status": "rejected",
	"anthropic-ratelimit-unified-5h-utilization": "0.04",
	"anthropic-ratelimit-unified-5h-reset": "1792131600",
	"anthropic-ratelimit-unified-7d-utilization": "0",
	"anthropic-ratelimit-unified-7d-reset": "1792375200",
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

// ---------------------------------------------------------------------------
// Claude subscription quota through pi-claude-bridge.
// ---------------------------------------------------------------------------

test("mapClaudeBridgeHeaders maps the bridge's unified headers", () => {
	const usage = mapClaudeBridgeHeaders(CLAUDE_HEADERS, NOW, "max");	assert.equal(usage?.provider, CLAUDE_BRIDGE_PROVIDER);
	assert.equal(usage?.provider, "claude-bridge");
	assert.equal(usage?.plan, "max");
	assert.equal(usage?.fetchedAt, NOW);
	assert.equal(usage?.limits.length, 1);
	assert.equal(usage?.limits[0]?.name, "claude");
	assert.equal(usage?.limits[0]?.limitReached, false);
	assert.deepEqual(
		usage?.limits[0]?.windows.map((window) => [window.label, window.usedPercent, window.windowSeconds, window.resetAt]),
		[
			["5h", 0, 18_000, 1792131600_000],
			["week", 0, 604_800, 1792375200_000],
		],
	);
	// The raw rate-limit payload this fixture was derived from stays as it was.
	assert.equal(CLAUDE_RATE_LIMIT_INFO.unifiedWindows.five_hour.resetsAt, 1792131600);
});

test("mapClaudeBridgeHeaders reads the header set a live bridge turn sends", () => {
	const usage = mapClaudeBridgeHeaders(CLAUDE_LIVE_HEADERS, NOW);
	assert.deepEqual(
		usage?.limits[0]?.windows.map((window) => [window.label, window.usedPercent, window.resetAt]),
		[
			["5h", 4, 1792131600_000],
			["week", 0, 1792375200_000],
		],
	);
	assert.equal(usage?.limits[0]?.limitReached, false);
});

test("mapClaudeBridgeHeaders turns fractions into percentages and clamps them", () => {
	const partial = mapClaudeBridgeHeaders({ ...CLAUDE_HEADERS, "anthropic-ratelimit-unified-5h-utilization": "0.43" }, NOW);
	assert.equal(partial?.limits[0]?.windows[0]?.usedPercent, 43);
	const over = mapClaudeBridgeHeaders({ ...CLAUDE_HEADERS, "anthropic-ratelimit-unified-7d-utilization": "1.5" }, NOW);
	assert.equal(over?.limits[0]?.windows[1]?.usedPercent, 100);
	const refused = mapClaudeBridgeHeaders({ ...CLAUDE_HEADERS, "anthropic-ratelimit-unified-status": "rejected" }, NOW);
	assert.equal(refused?.limits[0]?.limitReached, true);
	// Both ends of the clamp: a negative fraction is 0, not a broken bar.
	const negative = mapClaudeBridgeHeaders({ ...CLAUDE_HEADERS, "anthropic-ratelimit-unified-5h-utilization": "-0.5" }, NOW);
	assert.equal(negative?.limits[0]?.windows[0]?.usedPercent, 0);
	// Only the rejection status the bridge forwards marks the limit reached.
	assert.equal(mapClaudeBridgeHeaders({ ...CLAUDE_HEADERS, "anthropic-ratelimit-unified-status": "REJECTED" }, NOW)?.limits[0]?.limitReached, false);
});

test("mapClaudeBridgeHeaders refuses a header set that carries no window", () => {
	assert.equal(mapClaudeBridgeHeaders({}, NOW), undefined);
	// Status alone is not a percentage to render: it is what the bridge sends
	// when Claude Code reported no per-window usage.
	assert.equal(mapClaudeBridgeHeaders({ "anthropic-ratelimit-unified-status": "allowed" }, NOW), undefined);
	// One usable window still renders; the unusable one is dropped, not defaulted.
	const half = mapClaudeBridgeHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.2" }, NOW);
	assert.deepEqual(half?.limits[0]?.windows.map((window) => [window.label, window.usedPercent, window.resetAt]), [["week", 20, null]]);
	// A reset without a percentage is not a window either, and an unparseable
	// reset is "no reset", never a wrong timestamp.
	assert.equal(mapClaudeBridgeHeaders({ "anthropic-ratelimit-unified-5h-reset": "1792131600" }, NOW), undefined);
	const unparseable = mapClaudeBridgeHeaders({ ...CLAUDE_HEADERS, "anthropic-ratelimit-unified-5h-reset": "soon" }, NOW);
	assert.equal(unparseable?.limits[0]?.windows[0]?.resetAt, null);
});

test("readClaudePlan reads the plan label and never the token beside it", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sources-claude-"));
	const store = path.join(dir, ".credentials.json");
	fs.writeFileSync(
		store,
		JSON.stringify({
			claudeAiOauth: {
				accessToken: "must-not-survive-token",
				refreshToken: "must-not-survive-refresh",
				subscriptionType: "max",
				rateLimitTier: "default_claude_max_20x",
			},
		}),
	);
	assert.equal(readClaudePlan({ CLAUDE_CREDENTIALS: store }), "max");
	assert.doesNotMatch(String(readClaudePlan({ CLAUDE_CREDENTIALS: store })), /must-not-survive/);
	// Claude Code's own config dir names the store too.
	assert.equal(readClaudePlan({ CLAUDE_CONFIG_DIR: dir }), "max");
	// Missing, unparseable and plan-less stores are all "no label".
	assert.equal(readClaudePlan({ CLAUDE_CREDENTIALS: path.join(dir, "missing.json") }), undefined);
	fs.writeFileSync(path.join(dir, "broken.json"), "{not json");
	assert.equal(readClaudePlan({ CLAUDE_CREDENTIALS: path.join(dir, "broken.json") }), undefined);
	fs.writeFileSync(path.join(dir, "empty.json"), JSON.stringify({ claudeAiOauth: {} }));
	assert.equal(readClaudePlan({ CLAUDE_CREDENTIALS: path.join(dir, "empty.json") }), undefined);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("the claude-bridge source answers its last capture and nothing before it", async () => {
	const source = createClaudeBridgeSource({ readPlan: () => "pro" });
	assert.equal(source.hasSnapshot(), false);
	assert.equal(source.source.provider, "claude-bridge");
	assert.equal(source.source.schema, USAGE_SOURCE_SCHEMA);
	assert.equal(typeof source.source.pendingNote, "string");
	// A capture with no window is not a snapshot.
	assert.equal(source.capture({ "anthropic-ratelimit-unified-status": "allowed" }, NOW), false);
	assert.equal(source.hasSnapshot(), false);
	assert.equal(await source.source.fetch(undefined, async () => new Response("{}"), NOW), undefined);
	// The first real capture is the one that makes the source answer.
	const later = NOW + 60_000;
	assert.equal(source.capture(CLAUDE_HEADERS, later), true);
	assert.equal(source.hasSnapshot(), true);
	const usage = await source.source.fetch(undefined, async () => new Response("{}"), NOW + 120_000);
	assert.equal(usage?.provider, "claude-bridge");
	assert.equal(usage?.plan, "pro");
	// The snapshot keeps the moment the numbers arrived, not the moment they
	// were asked for again: the panel's "updated Nm ago" has to be honest.
	assert.equal(usage?.fetchedAt, later);
	const refreshed = await source.source.fetch(undefined, async () => new Response("{}"), NOW + 180_000);
	assert.equal(refreshed?.fetchedAt, later);
	// A new capture replaces the numbers in place.
	assert.equal(source.capture({ ...CLAUDE_HEADERS, "anthropic-ratelimit-unified-5h-utilization": "0.75" }, later + 1), true);
	const next = await source.source.fetch(undefined, async () => new Response("{}"), later + 2);
	assert.equal(next?.limits[0]?.windows[0]?.usedPercent, 75);
});

test("the claude-bridge source reads the plan from Claude Code's store once", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sources-plan-"));
	const store = path.join(dir, ".credentials.json");
	fs.writeFileSync(store, JSON.stringify({ claudeAiOauth: { accessToken: "must-not-survive", subscriptionType: "max" } }));
	const previous = process.env.CLAUDE_CREDENTIALS;
	process.env.CLAUDE_CREDENTIALS = store;
	try {
		// No injected reader: this is the path the extension actually takes.
		const source = createClaudeBridgeSource();
		assert.equal(source.capture(CLAUDE_HEADERS, NOW), true);
		const usage = await source.source.fetch(undefined, async () => new Response("{}"), NOW);
		assert.equal(usage?.plan, "max");
		assert.doesNotMatch(JSON.stringify(usage), /must-not-survive/);
		// A later snapshot does not re-read the store: the label is read once.
		fs.rmSync(store, { force: true });
		assert.equal(source.capture({ ...CLAUDE_HEADERS, "anthropic-ratelimit-unified-5h-utilization": "0.5" }, NOW + 1), true);
		const next = await source.source.fetch(undefined, async () => new Response("{}"), NOW + 2);
		assert.equal(next?.plan, "max");
	} finally {
		if (previous === undefined) delete process.env.CLAUDE_CREDENTIALS;
		else process.env.CLAUDE_CREDENTIALS = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("the extension captures Claude only on a claude-bridge turn", async () => {
	const emitted: Array<{ name: string; payload: { provider: string; fetch?: unknown } }> = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const fakePi = {
		events: { emit: (name: string, payload: unknown) => emitted.push({ name, payload: payload as { provider: string } }) },
		on: (event: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(event, handler),
	};
	const extensionModule = await import("../extensions/usage-sources.ts");
	extensionModule.default(fakePi as never, { claudeBridge: { readPlan: () => "max" } } as never);
	// Nothing yet: the provider was never asked for anything, so the shell keeps
	// its own note instead of recording a failed refresh.
	assert.deepEqual(emitted.map((entry) => entry.payload.provider), ["opencode-go", "antigravity"]);

	const response = handlers.get("after_provider_response");
	assert.ok(response, "the extension subscribes to after_provider_response");
	// A native anthropic response uses the same header names; it must not be
	// captured as the bridge's.
	response({ status: 200, headers: CLAUDE_HEADERS }, { model: { provider: "anthropic" } });
	assert.equal(emitted.length, 2);
	response({ status: 200, headers: { "anthropic-ratelimit-unified-status": "allowed" } }, { model: { provider: "claude-bridge" } });
	assert.equal(emitted.length, 2);

	response({ status: 200, headers: CLAUDE_HEADERS }, { model: { provider: "claude-bridge" } });
	assert.deepEqual(emitted.map((entry) => entry.payload.provider), ["opencode-go", "antigravity", "claude-bridge"]);
	assert.ok(emitted.every((entry) => entry.name === USAGE_SOURCE_EVENT));
	assert.equal(typeof emitted[2]?.payload.fetch, "function");
	const usage = await (emitted[2]?.payload.fetch as (apiKey: undefined, fetchFn: typeof fetch, now: number) => Promise<{ plan?: string; limits: Array<{ windows: Array<{ usedPercent: number }> }> }>)(undefined, fetch, NOW);
	assert.equal(usage.plan, "max");
	assert.equal(usage.limits[0]?.windows.length, 2);

	// A later window re-emits the source, which is what forces the shell's
	// refresh for that provider instead of waiting out its 5-minute throttle.
	response({ status: 200, headers: { ...CLAUDE_HEADERS, "anthropic-ratelimit-unified-5h-utilization": "0.5" } }, { model: { provider: "claude-bridge" } });
	assert.equal(emitted.length, 4);
	const replayed = await (emitted[3]?.payload.fetch as (apiKey: undefined, fetchFn: typeof fetch, now: number) => Promise<{ limits: Array<{ windows: Array<{ usedPercent: number }> }> }>)(undefined, fetch, NOW);
	assert.equal(replayed.limits[0]?.windows[0]?.usedPercent, 50);
	// A session start keeps re-registering the stateless pair plus the captured
	// source, so a reload never loses the numbers.
	handlers.get("session_start")?.({}, {});
	assert.deepEqual(emitted.slice(4).map((entry) => entry.payload.provider), ["opencode-go", "antigravity", "claude-bridge"]);
});
