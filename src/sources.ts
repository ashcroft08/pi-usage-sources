// Usage sources for Gentle Shell: OpenCode Go (HTTP), Antigravity (agy CLI)
// and Claude (pi-claude-bridge)
//
// Gentle Shell exposes a provider-neutral contract: an extension emits
// `gentle-pi:usage-source/v1` on `pi.events` with
// { schema, provider, pendingNote?, fetch(apiKey, fetchFn, now) }, and the shell
// treats that provider exactly like its own built-ins. This module builds the
// sources; it never prints, logs, or stores a credential.
//
// It exists because those providers have no built-in fetcher: without it, both
// the header's usage segment and the alt+u panel answer "no subscription usage
// for this provider" forever. No setting changes that. Claude is the one source
// fed by events rather than by a fetch (see createClaudeBridgeSource).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
export const USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";

export interface UsageWindow {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
}

export interface UsageLimit {
	name: string;
	windows: UsageWindow[];
	limitReached: boolean;
}

export interface ProviderUsage {
	provider: string;
	plan?: string;
	limits: UsageLimit[];
	fetchedAt: number;
}

export interface UsageSource {
	schema: typeof USAGE_SOURCE_SCHEMA;
	provider: string;
	pendingNote: string;
	fetch(apiKey: string | undefined, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined>;
}

export interface SourceDeps {
	env?: NodeJS.ProcessEnv;
	fetchFn?: typeof fetch;
	runAgyJson?: (binary: string) => Promise<string | undefined>;
	agyBinary?: string;
	now?: () => number;
	claudeBridge?: ClaudeBridgeDeps;
}

export const OPENCODE_GO_PROVIDER = "opencode-go";
export const ANTIGRAVITY_PROVIDER = "antigravity";
export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
const OPENCODE_GO_URL = "https://opencode.ai/zen/go/v1/usage";
const AGY_ARGS = ["--print", "/usage", "--output-format", "json", "--print-timeout", "30s"];

const REQUEST_TIMEOUT_MS = 8_000;
// The shell's own fetch budget is 10s (GENTLE_PI_SHELL_USAGE_TIMEOUT_MS) and a
// late answer is discarded, so the spawn gives up just before it and reports
// "no data yet" instead of racing the budget. A healthy agy answers in ~3s.
const AGY_BUDGET_MS = 8_000;
const FIVE_HOURS = 18_000;
const WEEK = 604_800;
const MONTH = 30 * 86_400;
// Anthropic's own unified rate-limit header names, which is what the bridge
// rebuilds from Claude Code's rate_limit_event. Same names the shell's built-in
// anthropic parser reads, so the numbers mean the same thing on both paths.
const UNIFIED_PREFIX = "anthropic-ratelimit-unified-";
const CLAUDE_MAIN_LIMIT = "claude";
const CLAUDE_WINDOWS: ReadonlyArray<[key: string, label: string, seconds: number]> = [
	["5h", "5h", FIVE_HOURS],
	["7d", "week", WEEK],
];

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function timestamp(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || value.length === 0) return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

/** Map OpenCode Go's rolling/weekly/monthly utilization response. */
export function mapOpenCodeGo(payload: unknown, now: number): ProviderUsage | undefined {
	const usage = record(record(payload)?.usage);
	if (!usage) return undefined;
	const windows: UsageWindow[] = [];
	for (const [key, label, seconds] of [
		["rolling", "5h", FIVE_HOURS],
		["weekly", "week", WEEK],
		["monthly", "month", MONTH],
	] as const) {
		const raw = record(usage[key]);
		if (!raw || raw.status !== "ok") continue;
		const percent = finite(raw.percent);
		if (percent === undefined) continue;
		windows.push({
			label,
			// This endpoint reports usage, not what is left.
			usedPercent: clampPercent(percent),
			windowSeconds: seconds,
			// The field is `resetsAt` (with the s). Read every spelling so a
			// rename on either side cannot silently drop the reset countdown.
			resetAt: timestamp(raw.resetsAt ?? raw.resetAt ?? raw.reset_at ?? raw.resetTime),
		});
	}
	if (windows.length === 0) return undefined;
	return {
		provider: OPENCODE_GO_PROVIDER,
		plan: "Go",
		limits: [{ name: "opencode", windows, limitReached: windows.some((window) => window.usedPercent >= 100) }],
		fetchedAt: now,
	};
}

function windowSecondsFor(window: unknown, label: string): number {
	const source = `${typeof window === "string" ? window : ""} ${label}`;
	if (/(?:five|5)\s*(?:hour|h)\b/i.test(source)) return FIVE_HOURS;
	if (/\b(?:weekly|week|7d)\b/i.test(source)) return WEEK;
	if (/\bmonthly|month\b/i.test(source)) return MONTH;
	return 0;
}

function windowLabelFor(seconds: number, fallback: string): string {
	if (seconds === FIVE_HOURS) return "5h";
	if (seconds === WEEK) return "week";
	if (seconds === MONTH) return "month";
	return fallback;
}

/** Map the `agy --print /usage --output-format json` envelope. */
export function mapAntigravityEnvelope(payload: unknown, now: number): ProviderUsage | undefined {
	const envelope = record(payload);
	const status = typeof envelope?.status === "string" ? envelope.status.toUpperCase() : "";
	if (status !== "" && status !== "SUCCESS" && status !== "OK") return undefined;
	const command = record(envelope?.command);
	if (command?.name !== "usage") return undefined;
	const data = record(command.data);
	const groups = Array.isArray(data?.groups) ? data.groups : undefined;
	if (!groups) return undefined;
	const limits: UsageLimit[] = [];
	for (const rawGroup of groups) {
		const group = record(rawGroup);
		const buckets = Array.isArray(group?.buckets) ? group.buckets : undefined;
		if (!group || !buckets) continue;
		const windows: UsageWindow[] = [];
		for (const rawBucket of buckets) {
			const bucket = record(rawBucket);
			const remaining = finite(bucket?.remaining_fraction ?? bucket?.remainingFraction);
			if (!bucket || remaining === undefined) continue;
			const name = typeof bucket.name === "string" && bucket.name.length > 0 ? bucket.name : typeof bucket.id === "string" ? bucket.id : "quota";
			const seconds = windowSecondsFor(bucket.window, name);
			windows.push({
				label: windowLabelFor(seconds, name),
				// The CLI reports what is LEFT; the shell renders what is USED.
				usedPercent: clampPercent((1 - remaining) * 100),
				windowSeconds: seconds,
				resetAt: timestamp(bucket.reset_time ?? bucket.resetTime),
			});
		}
		if (windows.length === 0) continue;
		windows.sort((left, right) => left.windowSeconds - right.windowSeconds);
		limits.push({
			name: typeof group.name === "string" && group.name.length > 0 ? group.name : "antigravity",
			windows,
			limitReached: windows.some((window) => window.usedPercent >= 100),
		});
	}
	if (limits.length === 0) return undefined;
	return { provider: ANTIGRAVITY_PROVIDER, limits, fetchedAt: now };
}

/** Fetch one OpenCode Go snapshot. Never throws, never returns a partial read. */
export async function fetchOpenCodeGoUsage(token: string, fetchFn: typeof fetch, now: number): Promise<ProviderUsage | undefined> {
	try {
		const response = await fetchFn(OPENCODE_GO_URL, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		return mapOpenCodeGo(await response.json(), now);
	} catch {
		return undefined;
	}
}

/** Run agy's /usage command in print mode and hand back its raw stdout. */
export function runAgyJson(binary: string, budgetMs: number = AGY_BUDGET_MS): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		let out = "";
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			if (watchdog) clearTimeout(watchdog);
			resolve(value);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(binary, AGY_ARGS, { stdio: ["ignore", "pipe", "ignore"], shell: false });
		} catch {
			finish(undefined);
			return;
		}
		watchdog = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
			finish(undefined);
		}, budgetMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			out += chunk;
		});
		child.on("error", () => finish(undefined));
		child.on("close", (code) => finish(code === 0 && out.trim().length > 0 ? out : undefined));
	});
}

/** Resolve the agy binary the same way the bridge does. */
export function agyBinary(env: NodeJS.ProcessEnv = process.env): string {
	return env.AGY_BIN?.trim() || "agy";
}

/**
 * The Go API key: the credential the shell passed when it has one, else pi's own
 * store. gentle-shell runs every session under its own home, so
 * PI_CODING_AGENT_DIR there points at ~/.gentle-shell/agent, which carries no
 * opencode-go credential - the user's own pi home is the reliable one.
 *
 * OPENCODE_GO_AUTH is an exclusive override: when it is set, it is the only file
 * read, so a caller (or a test) can point at a store without the machine's own
 * pi home silently answering instead.
 */
export function readOpenCodeGoKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.OPENCODE_GO_AUTH) return readKeyFromFile(env.OPENCODE_GO_AUTH);
	const candidates = [path.join(os.homedir(), ".pi", "agent", "auth.json")];
	if (env.PI_CODING_AGENT_DIR) candidates.push(path.join(env.PI_CODING_AGENT_DIR, "auth.json"));
	for (const file of candidates) {
		const key = readKeyFromFile(file);
		if (key) return key;
	}
	return undefined;
}

function readKeyFromFile(file: string): string | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, { key?: unknown }>;
		const key = parsed?.[OPENCODE_GO_PROVIDER]?.key;
		return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Map the unified rate-limit headers pi-claude-bridge hands to pi's
 * `after_provider_response`.
 *
 * Claude Code reports plan usage as SDK `rate_limit_event` messages rather than
 * HTTP headers, so the bridge rebuilds Anthropic's own header names from them
 * (`five_hour` -> `5h`, `seven_day` -> `7d`). `utilization` is a fraction and
 * `resetsAt` is Unix seconds on both paths.
 *
 * Returns undefined when no window carries a percentage: a bridge that answered
 * with status alone reported no per-window usage, which is nothing to render.
 */
export function mapClaudeBridgeHeaders(headers: Record<string, string>, now: number, plan?: string): ProviderUsage | undefined {
	const windows: UsageWindow[] = [];
	for (const [key, label, seconds] of CLAUDE_WINDOWS) {
		const fraction = Number.parseFloat(headers[`${UNIFIED_PREFIX}${key}-utilization`] ?? "");
		if (!Number.isFinite(fraction)) continue;
		const reset = Number.parseInt(headers[`${UNIFIED_PREFIX}${key}-reset`] ?? "", 10);
		windows.push({
			label,
			usedPercent: clampPercent(fraction * 100),
			windowSeconds: seconds,
			resetAt: Number.isFinite(reset) ? reset * 1000 : null,
		});
	}
	if (windows.length === 0) return undefined;
	return {
		provider: CLAUDE_BRIDGE_PROVIDER,
		plan,
		limits: [{ name: CLAUDE_MAIN_LIMIT, windows, limitReached: headers[`${UNIFIED_PREFIX}status`] === "rejected" }],
		fetchedAt: now,
	};
}

/**
 * The plan label, from the store Claude Code already owns. Read-only, and only
 * this one field: the OAuth token that sits beside it is never read, kept,
 * logged, or returned. Claude Code keeps its store in the Keychain on macOS, so
 * there the file is simply absent and the label stays empty.
 *
 * CLAUDE_CREDENTIALS is an exclusive override, like OPENCODE_GO_AUTH: when it is
 * set it is the only file read, so a test can point at a store without the
 * machine's own Claude Code store answering instead.
 */
export function readClaudePlan(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const file = env.CLAUDE_CREDENTIALS ?? path.join(env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), ".credentials.json");
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { claudeAiOauth?: { subscriptionType?: unknown } };
		const plan = parsed?.claudeAiOauth?.subscriptionType;
		return typeof plan === "string" && plan.trim().length > 0 ? plan.trim() : undefined;
	} catch {
		return undefined;
	}
}

export interface ClaudeBridgeDeps {
	/** The plan label reader. Injected by tests; the real store by default. */
	readPlan?: () => string | undefined;
}

export interface ClaudeBridgeSource {
	/** Remembers one captured header set. True when it produced a snapshot. */
	capture(headers: Record<string, string>, now: number): boolean;
	hasSnapshot(): boolean;
	/** The source to emit on `gentle-pi:usage-source/v1`. */
	source: UsageSource;
}

/**
 * Claude's plan usage arrives with responses, not from a fetch, so this source
 * answers the last captured snapshot instead of asking an endpoint.
 *
 * It is registered only once there is a snapshot to answer with: registering a
 * provider the shell then tries to fetch would record a failed refresh for a
 * provider nothing was ever asked of, which is exactly the wrong story to tell
 * before Claude Code has reported anything. Every later capture re-emits the
 * source, and a re-registration makes the shell refresh that provider at once.
 */
export function createClaudeBridgeSource(deps: ClaudeBridgeDeps = {}): ClaudeBridgeSource {
	let latest: ProviderUsage | undefined;
	// The plan is read at most once per process, on the first snapshot: a label
	// that changes mid-session is not worth a store read on every turn.
	let plan: string | undefined;
	let planRead = false;
	const planLabel = (): string | undefined => {
		if (!planRead) {
			planRead = true;
			plan = deps.readPlan ? deps.readPlan() : readClaudePlan();
		}
		return plan;
	};
	const source: UsageSource = {
		schema: USAGE_SOURCE_SCHEMA,
		provider: CLAUDE_BRIDGE_PROVIDER,
		pendingNote: "usage arrives with the first response",
		fetch: async () => latest,
	};
	return {
		source,
		hasSnapshot: () => latest !== undefined,
		capture: (headers, now) => {
			const usage = mapClaudeBridgeHeaders(headers, now);
			if (!usage) return false;
			latest = { ...usage, plan: planLabel() };
			return true;
		},
	};
}

/** The two sources with no state of their own, ready to emit on the event. */
export function buildSources(deps: SourceDeps = {}): UsageSource[] {
	const env = deps.env ?? process.env;
	const runAgy = deps.runAgyJson ?? ((binary: string) => runAgyJson(binary));
	const binary = deps.agyBinary ?? agyBinary(env);

	const opencodeGo: UsageSource = {
		schema: USAGE_SOURCE_SCHEMA,
		provider: OPENCODE_GO_PROVIDER,
		pendingNote: "no usage yet · r to fetch",
		fetch: async (apiKey, fetchFn, now) => {
			const token = apiKey?.trim() || readOpenCodeGoKey(env);
			if (!token) return undefined;
			return fetchOpenCodeGoUsage(token, fetchFn ?? deps.fetchFn ?? fetch, now);
		},
	};

	const antigravity: UsageSource = {
		schema: USAGE_SOURCE_SCHEMA,
		provider: ANTIGRAVITY_PROVIDER,
		pendingNote: "reading agy · r to fetch",
		fetch: async (_apiKey, _fetchFn, now) => {
			const raw = await runAgy(binary);
			if (!raw) return undefined;
			try {
				return mapAntigravityEnvelope(JSON.parse(raw), now);
			} catch {
				return undefined;
			}
		},
	};

	return [opencodeGo, antigravity];
}
