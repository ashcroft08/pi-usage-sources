// Live check: runs the real sources against the real accounts, no stubs.
//   node verify-live.ts
import { buildSources } from "./src/sources.ts";

const now = Date.now();
const sources = buildSources({});

for (const source of sources) {
	const started = Date.now();
	let usage: Awaited<ReturnType<typeof source.fetch>>;
	try {
		usage = await source.fetch(undefined, fetch, now);
	} catch (error) {
		console.log(`\n${source.provider}: THREW ${String(error)}`);
		continue;
	}
	const ms = Date.now() - started;
	console.log(`\n${source.provider}  ${ms}ms  ->  ${usage ? "OK" : "sin datos"}`);
	if (!usage) continue;
	for (const limit of usage.limits) {
		for (const window of limit.windows) {
			const reset = window.resetAt === null ? "sin reset" : `resetea en ${Math.max(0, Math.round((window.resetAt - now) / 60_000))} min`;
			console.log(`   ${limit.name.padEnd(22)} ${window.label.padEnd(6)} usado ${window.usedPercent.toFixed(1).padStart(5)}%   ${reset}`);
		}
	}
}
console.log("");
