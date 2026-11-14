// Headless JSON: the same subscription usage the shell's alt+u panel renders,
// as one versioned document a program outside pi can parse. No pi runtime, no
// TUI, and no credential: a token never reaches the document.
//
// `usage-json.ts` (the entry point) prints this. `verify-live.ts` (the human
// tool) shares the fetch-with-timeout helper below, so both give up on a
// provider at the same budget.
import type { ProviderUsage, UsageLimit, UsageSource, UsageWindow } from "./sources.ts";

export const USAGE_JSON_SCHEMA = "pi-usage-sources/usage/v1";

/**
 * Per-source budget. gentle-shell discards an answer that lands after its own
 * 10s fetch budget, and a headless run has the same reason to give up: one
 * provider that hangs must not hold every other provider's numbers.
 */
export const DEFAULT_SOURCE_TIMEOUT_MS = 10_000;

export type UsageJsonStatus = "ok" | "no-data" | "failed";

export interface UsageJsonWindow {
	label: string;
	usedPercent: number;
	resetAt: number | null;
	windowSeconds: number | null;
}

export interface UsageJsonLimit {
	name: string;
	limitReached: boolean;
	windows: UsageJsonWindow[];
}

export interface UsageJsonSource {
	provider: string;
	status: UsageJsonStatus;
	/** One short, redacted reason. Only present when status is "failed". */
	error?: string;
	plan?: string;
	fetchedAt: number;
	limits: UsageJsonLimit[];
}

export interface UsageJsonDocument {
	schema: string;
	generatedAt: number;
	sources: UsageJsonSource[];
}

export interface SourceAttempt {
	status: UsageJsonStatus;
	usage?: ProviderUsage;
	/** The thrown value, or an Error whose message is the overrun budget. */
	error?: unknown;
	elapsedMs: number;
}

/**
 * Run one source with a bounded budget. The result is a status, never a throw:
 * a provider that answers nothing, throws or overruns is reported, not
 * propagated, because the caller still has a document to print.
 */
export async function fetchWithTimeout(
	source: UsageSource,
	fetchFn: typeof fetch,
	now: number,
	budgetMs: number = DEFAULT_SOURCE_TIMEOUT_MS,
): Promise<SourceAttempt> {
	const started = Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const budget = new Promise<SourceAttempt>((resolve) => {
		// Deliberately not unref'd: while a source hangs, this timer is the only
		// thing keeping the process alive long enough to report the overrun.
		timer = setTimeout(() => {
			resolve({ status: "failed", error: new Error(`timed out after ${budgetMs}ms`), elapsedMs: Date.now() - started });
		}, budgetMs);
	});
	try {
		const fetched = source.fetch(undefined, fetchFn, now).then(
			(usage): SourceAttempt => ({ status: usage ? "ok" : "no-data", usage, elapsedMs: Date.now() - started }),
			// A source that loses the race still settles here, so no rejection is
			// left unhandled.
			(error): SourceAttempt => ({ status: "failed", error, elapsedMs: Date.now() - started }),
		);
		return await Promise.race([fetched, budget]);
	} catch (error) {
		return { status: "failed", error, elapsedMs: Date.now() - started };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * One short reason for a failed provider. Errors can quote a URL or an
 * authorization header, so anything credential-shaped is redacted before it can
 * reach a document that gets printed, piped or stored.
 */
export function shortReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const cleaned = message
		.replace(/\b(bearer|basic)\s+\S+/gi, "$1 <redacted>")
		.replace(/[A-Za-z0-9_+/=-]{24,}/g, "<redacted>")
		.replace(/\s+/g, " ")
		.trim();
	return (cleaned.length > 0 ? cleaned : "unknown error").slice(0, 140);
}

function jsonWindow(window: UsageWindow): UsageJsonWindow {
	return {
		label: window.label,
		usedPercent: window.usedPercent,
		// A provider that reports no reset keeps an explicit null: the reader can
		// tell "no countdown" from "field missing".
		resetAt: window.resetAt ?? null,
		windowSeconds: window.windowSeconds ?? null,
	};
}

function jsonLimit(limit: UsageLimit): UsageJsonLimit {
	return { name: limit.name, limitReached: limit.limitReached, windows: limit.windows.map(jsonWindow) };
}

function jsonSource(source: UsageSource, attempt: SourceAttempt, now: number): UsageJsonSource {
	const usage = attempt.status === "ok" ? attempt.usage : undefined;
	const entry: UsageJsonSource = { provider: source.provider, status: attempt.status };
	if (attempt.status === "failed") entry.error = shortReason(attempt.error);
	if (usage?.plan) entry.plan = usage.plan;
	// A provider with nothing to report keeps the moment it was asked, so the
	// document says when that answer was true.
	entry.fetchedAt = usage?.fetchedAt ?? now;
	entry.limits = (usage?.limits ?? []).map(jsonLimit);
	return entry;
}

export interface UsageJsonOptions {
	/** Per-source budget; overridable so a test need not wait 10s. */
	timeoutMs?: number;
	/** The fetch the sources run with. Defaults to the global one. */
	fetchFn?: typeof fetch;
	/** One clock for the whole run, so every entry shares the same `now`. */
	now?: number;
}

/**
 * Run every source and build the document. Sources run together, each inside
 * its own budget, and a failing one is a status: the document is always
 * produced, which is what lets the caller exit 0 and let the reader decide.
 */
export async function collectUsageJson(sources: UsageSource[], options: UsageJsonOptions = {}): Promise<UsageJsonDocument> {
	const now = options.now ?? Date.now();
	const fetchFn = options.fetchFn ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
	const attempts = await Promise.all(sources.map((source) => fetchWithTimeout(source, fetchFn, now, timeoutMs)));
	return {
		schema: USAGE_JSON_SCHEMA,
		generatedAt: now,
		sources: sources.map((source, index) => jsonSource(source, attempts[index] as SourceAttempt, now)),
	};
}

/** The document as the single line the entry point writes to stdout. */
export function serializeUsageJson(document: UsageJsonDocument): string {
	return `${JSON.stringify(document)}\n`;
}
