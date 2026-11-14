// The headless JSON document: the same subscription usage the alt+u panel
// renders, as one versioned document a program outside pi can parse. No
// network: every fetch and every agy run is injected, except in the one test
// that runs the entry point with no credential and no agy to find.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildSources, USAGE_SOURCE_SCHEMA, type UsageSource } from "../src/sources.ts";
import { collectUsageJson, serializeUsageJson, USAGE_JSON_SCHEMA } from "../src/usage-json.ts";

const NOW = 1_792_000_000_000;

// Fake credentials, long enough to be credential-shaped: the document must
// never carry them, whatever a provider answers.
const OPENCODE_TOKEN = "sk-must-not-survive-opencode-go-key";
const COMMAND_CODE_TOKEN = "cmd-must-not-survive-access-token";

const OPENCODE_PAYLOAD = {
	usage: {
		rolling: { status: "ok", percent: 12.5, resetsAt: "2026-10-15T08:56:52.000Z" },
		weekly: { status: "ok", percent: 43, resetsAt: "2026-10-19T00:00:00.000Z" },
	},
};

// The `agy --print /usage --output-format json` envelope, trimmed to one bucket.
// It carries no `reset_time`, which is the null the document has to preserve.
const AGY_ENVELOPE = {
	status: "SUCCESS",
	command: {
		name: "usage",
		data: {
			groups: [
				{
					name: "Gemini Models",
					buckets: [{ id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.75 }],
				},
			],
		},
	},
};

const COMMAND_CODE_CREDITS = {
	credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 },
	windowLimits: { fiveHour: { used: 1, cap: 4, resetAt: 1_793_746_765_237 } },
};

interface FetchOptions {
	opencode?: () => Promise<Response>;
	commandcode?: () => Promise<Response>;
}

/** One scripted endpoint set for the two fetching sources. */
function stubFetch(options: FetchOptions = {}) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
		if (url === "https://opencode.ai/zen/go/v1/usage") {
			return options.opencode ? options.opencode() : new Response(JSON.stringify(OPENCODE_PAYLOAD), { status: 200 });
		}
		if (options.commandcode) return options.commandcode();
		if (url.endsWith("/alpha/whoami")) return new Response(JSON.stringify({ org: null }), { status: 200 });
		if (url.includes("/alpha/billing/credits")) return new Response(JSON.stringify(COMMAND_CODE_CREDITS), { status: 200 });
		if (url.includes("/alpha/billing/subscriptions")) return new Response(JSON.stringify({ data: { planId: "individual-go-v1" } }), { status: 200 });
		return new Response(JSON.stringify({ totalCost: 0 }), { status: 200 });
	}) as typeof fetch;
	return { fetchFn, calls };
}

/** A temp store per source, so no real credential on this machine can answer. */
function stores() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sources-json-"));
	const opencode = path.join(dir, "opencode.json");
	const commandcode = path.join(dir, "commandcode.json");
	fs.writeFileSync(opencode, JSON.stringify({ "opencode-go": { type: "api_key", key: OPENCODE_TOKEN } }));
	fs.writeFileSync(commandcode, JSON.stringify({ commandcode: { access: COMMAND_CODE_TOKEN } }));
	return { dir, env: { OPENCODE_GO_AUTH: opencode, COMMANDCODE_AUTH: commandcode } };
}

test("collectUsageJson builds the schema, the timestamp and one entry per source", async () => {
	const { dir, env } = stores();
	const sources = buildSources({ env, runAgyJson: async () => JSON.stringify(AGY_ENVELOPE) });
	const document = await collectUsageJson(sources, { fetchFn: stubFetch().fetchFn, now: NOW });
	assert.equal(document.schema, "pi-usage-sources/usage/v1");
	assert.equal(document.schema, USAGE_JSON_SCHEMA);
	assert.equal(document.generatedAt, NOW);
	assert.deepEqual(
		document.sources.map((entry) => entry.provider),
		["opencode-go", "antigravity", "commandcode"],
	);
	assert.deepEqual(
		document.sources.map((entry) => entry.status),
		["ok", "ok", "ok"],
	);
	for (const entry of document.sources) {
		assert.equal(entry.error, undefined);
		assert.ok(entry.limits.length > 0, `${entry.provider} carries its windows`);
		assert.equal(typeof entry.fetchedAt, "number");
	}
	fs.rmSync(dir, { recursive: true, force: true });
});

test("collectUsageJson maps the provider's limits and windows into the document", async () => {
	const { dir, env } = stores();
	const sources = buildSources({ env, runAgyJson: async () => JSON.stringify(AGY_ENVELOPE) });
	const document = await collectUsageJson(sources, { fetchFn: stubFetch().fetchFn, now: NOW });
	const opencode = document.sources[0];
	assert.equal(opencode?.provider, "opencode-go");
	assert.equal(opencode?.plan, "Go");
	assert.equal(opencode?.fetchedAt, NOW);
	assert.deepEqual(opencode?.limits, [
		{
			name: "opencode",
			limitReached: false,
			windows: [
				{ label: "5h", usedPercent: 12.5, resetAt: Date.parse("2026-10-15T08:56:52.000Z"), windowSeconds: 18_000 },
				{ label: "week", usedPercent: 43, resetAt: Date.parse("2026-10-19T00:00:00.000Z"), windowSeconds: 604_800 },
			],
		},
	]);
	// The plan label travels; a source without one simply omits it.
	assert.equal(document.sources[1]?.plan, undefined);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("collectUsageJson preserves a null resetAt instead of dropping the field", async () => {
	const { dir, env } = stores();
	const sources = buildSources({ env, runAgyJson: async () => JSON.stringify(AGY_ENVELOPE) });
	const document = await collectUsageJson(sources, { fetchFn: stubFetch().fetchFn, now: NOW });
	const window = document.sources[1]?.limits[0]?.windows[0];
	assert.ok(window, "the agy bucket is a window");
	assert.equal(window.label, "5h");
	assert.equal(window.usedPercent, 25);
	assert.ok("resetAt" in window, "resetAt is a field even when there is no reset");
	assert.equal(window.resetAt, null);
	// ... and it survives the serialization as an explicit null.
	const parsed = JSON.parse(serializeUsageJson(document));
	assert.equal(parsed.sources[1].limits[0].windows[0].resetAt, null);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a source with nothing to answer is no-data and one that throws is failed", async () => {
	const { dir, env } = stores();
	// agy is the one source whose failure escapes its own fetch, which is what
	// makes it the real failed status rather than a no-data one.
	const sources = buildSources({
		env,
		runAgyJson: async () => {
			throw new Error("agy failed");
		},
	});
	const document = await collectUsageJson(sources, {
		now: NOW,
		// A rejected key is nothing to render, not a failure.
		fetchFn: stubFetch({ opencode: async () => new Response("unauthorized", { status: 401 }) }).fetchFn,
	});
	assert.deepEqual(
		document.sources.map((entry) => [entry.provider, entry.status]),
		[
			["opencode-go", "no-data"],
			["antigravity", "failed"],
			["commandcode", "ok"],
		],
	);
	// no-data has nothing to show and nothing to explain.
	assert.deepEqual(document.sources[0]?.limits, []);
	assert.equal(document.sources[0]?.error, undefined);
	// failed explains itself and carries no limits.
	assert.match(document.sources[1]?.error ?? "", /agy failed/);
	assert.deepEqual(document.sources[1]?.limits, []);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("no credential from the environment reaches the document", async () => {
	const { dir, env } = stores();
	const sources = buildSources({ env, runAgyJson: async () => JSON.stringify(AGY_ENVELOPE) });
	// A source is not trusted with the document: whatever it throws is redacted.
	const leaky: UsageSource = {
		schema: USAGE_SOURCE_SCHEMA,
		provider: "leaky",
		pendingNote: "",
		fetch: async () => {
			throw new Error(`Authorization: Bearer ${OPENCODE_TOKEN} token=${COMMAND_CODE_TOKEN}`);
		},
	};
	const stub = stubFetch();
	const document = await collectUsageJson([...sources, leaky], { fetchFn: stub.fetchFn, now: NOW });
	// The credentials really were in play: both stores were read and sent.
	assert.equal(stub.calls.find((call) => call.url === "https://opencode.ai/zen/go/v1/usage")?.headers.Authorization, `Bearer ${OPENCODE_TOKEN}`);
	assert.ok(stub.calls.some((call) => call.headers.Authorization === `Bearer ${COMMAND_CODE_TOKEN}`));
	// ... and neither reaches the document, printed or serialized.
	const serialized = serializeUsageJson(document);
	assert.doesNotMatch(serialized, /must-not-survive/);
	assert.doesNotMatch(serialized, new RegExp(OPENCODE_TOKEN));
	assert.doesNotMatch(serialized, new RegExp(COMMAND_CODE_TOKEN));
	assert.equal(document.sources[3]?.status, "failed");
	assert.match(document.sources[3]?.error ?? "", /bearer <redacted>/i);
	assert.match(document.sources[3]?.error ?? "", /<redacted>/);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("a provider that never answers is failed inside its own budget, not the run", async () => {
	const hangs: UsageSource = { schema: USAGE_SOURCE_SCHEMA, provider: "hangs", pendingNote: "", fetch: () => new Promise<never>(() => {}) };
	const answers: UsageSource = {
		schema: USAGE_SOURCE_SCHEMA,
		provider: "answers",
		pendingNote: "",
		fetch: async () => ({ provider: "answers", limits: [], fetchedAt: NOW }),
	};
	const started = Date.now();
	const document = await collectUsageJson([hangs, answers], { now: NOW, timeoutMs: 50 });
	assert.equal(document.sources[0]?.status, "failed");
	assert.match(document.sources[0]?.error ?? "", /timed out/);
	assert.equal(document.sources[1]?.status, "ok");
	// The healthy source was not held behind the hanging one.
	assert.ok(Date.now() - started < 5_000, "the run did not wait for the hang");
});

test("the entry point prints one JSON document and exits 0 when nothing has data", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sources-json-cli-"));
	const missing = (name: string) => path.join(dir, name);
	const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "usage-json.ts")], {
		encoding: "utf8",
		env: {
			...process.env,
			// No credential and no agy to find, for any source.
			HOME: dir,
			USERPROFILE: dir,
			PI_CODING_AGENT_DIR: dir,
			OPENCODE_GO_AUTH: missing("no-opencode.json"),
			COMMANDCODE_AUTH: missing("no-commandcode.json"),
			CLAUDE_CREDENTIALS: missing("no-claude.json"),
			CLAUDE_USAGE_SNAPSHOT: missing("no-snapshot.json"),
			AGY_BIN: missing("no-agy"),
		},
	});
	try {
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stderr, "");
		// One document and nothing else: a single line that parses.
		assert.equal(result.stdout.trim().split("\n").length, 1);
		const document = JSON.parse(result.stdout);
		assert.equal(document.schema, "pi-usage-sources/usage/v1");
		assert.equal(typeof document.generatedAt, "number");
		assert.deepEqual(
			document.sources.map((entry) => [entry.provider, entry.status]),
			[
				["opencode-go", "no-data"],
				["antigravity", "no-data"],
				["commandcode", "no-data"],
				["claude-bridge", "no-data"],
			],
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
