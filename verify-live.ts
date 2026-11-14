// Live check: runs the real sources against the real accounts, no stubs.
//   node verify-live.ts
//
// Same fetch-with-timeout budget as usage-json.ts, so a provider that hangs is
// reported instead of holding the run.
import { buildSources } from "./src/sources.ts";
import { fetchWithTimeout } from "./src/usage-json.ts";

const now = Date.now();
const sources = buildSources({});

for (const source of sources) {
	const attempt = await fetchWithTimeout(source, fetch, now);
	if (attempt.status === "failed") {
		console.log(`\n${source.provider}: THREW ${String(attempt.error)}`);
		continue;
	}
	const usage = attempt.usage;
	console.log(`\n${source.provider}  ${attempt.elapsedMs}ms  ->  ${usage ? "OK" : "sin datos"}`);
	if (!usage) continue;
	for (const limit of usage.limits) {
		for (const window of limit.windows) {
			const reset = window.resetAt === null ? "sin reset" : `resetea en ${Math.max(0, Math.round((window.resetAt - now) / 60_000))} min`;
			console.log(`   ${limit.name.padEnd(22)} ${window.label.padEnd(6)} usado ${window.usedPercent.toFixed(1).padStart(5)}%   ${reset}`);
		}
	}
}
console.log("");
