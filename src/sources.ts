// Usage sources for Gentle Shell: OpenCode Go (HTTP) and Antigravity (agy CLI).
//
// Gentle Shell exposes a provider-neutral contract: an extension emits
// `gentle-pi:usage-source/v1` on `pi.events` with
// { schema, provider, pendingNote?, fetch(apiKey, fetchFn, now) }, and the shell
// treats that provider exactly like its own built-ins. This module builds the
// two sources; it never prints, logs, or stores a credential.
//
// It exists because those two providers have no built-in fetcher: without it,
// both the header's usage segment and the alt+u panel answer "no subscription
// usage for this provider" forever. No setting changes that.
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
}

export const OPENCODE_GO_PROVIDER = "opencode-go";
export const ANTIGRAVITY_PROVIDER = "antigravity";
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

/** The two sources, ready to emit on `gentle-pi:usage-source/v1`. */
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
