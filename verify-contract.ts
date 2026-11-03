// Contract check without importing the shell's module.
//
// gentle-pi's lib/shell-usage.ts cannot load standalone: it imports
// "@earendil-works/pi-tui", which Pi injects at runtime and which is not on
// disk. So this reads the validator's own constants and gates out of the
// installed copies and checks the emitted payloads against them. If any gate
// disagrees, the shell silently ignores the source and the header and the alt+u
// panel keep saying "no subscription usage for this provider".
//
//   node verify-contract.ts
//   GENTLE_PI_CONTRACT_FILES=/path/a.ts:/path/b.ts node verify-contract.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildSources, createClaudeBridgeSource, USAGE_SOURCE_EVENT, USAGE_SOURCE_SCHEMA } from "./src/sources.ts";

const RELATIVE = path.join("npm", "node_modules", "gentle-pi", "lib", "shell-usage.ts");

/** Every pi home on this machine, plus the global npm root. */
function candidateFiles(): string[] {
	const homes: string[] = [];
	if (process.env.PI_CODING_AGENT_DIR) homes.push(process.env.PI_CODING_AGENT_DIR);
	homes.push(path.join(os.homedir(), ".pi", "agent"));
	homes.push(path.join(os.homedir(), ".gentle-shell", "agent"));
	const files = homes.map((home) => path.join(home, RELATIVE));
	try {
		const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
		if (root) files.push(path.join(root, "gentle-pi", "lib", "shell-usage.ts"));
	} catch {
		// No global npm on PATH: the per-home copies are enough.
	}
	if (process.env.APPDATA) files.push(path.join(process.env.APPDATA, "npm", "node_modules", "gentle-pi", "lib", "shell-usage.ts"));
	const override = process.env.GENTLE_PI_CONTRACT_FILES;
	if (override) files.push(...override.split(path.delimiter).filter(Boolean));
	return [...new Set(files)].filter((file) => {
		try {
			return fs.statSync(file).isFile();
		} catch {
			return false;
		}
	});
}

const files = candidateFiles();
if (files.length === 0) {
	console.error("No installed gentle-pi lib/shell-usage.ts found. Set GENTLE_PI_CONTRACT_FILES.");
	process.exit(2);
}

// Every source this package registers, stateless or not: the shell validates
// the registration payload, never the numbers behind it, so the Claude source
// is checked here exactly as it is emitted (built now, registered once it has a
// snapshot to answer with).
const sources = [...buildSources({}), createClaudeBridgeSource().source];
let failures = 0;
const check = (label: string, ok: boolean, detail: string) => {
	if (!ok) failures += 1;
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(22)} ${detail}`);
};

console.log(`schema: ${USAGE_SOURCE_SCHEMA}`);
console.log(`event:  ${USAGE_SOURCE_EVENT}`);
console.log(`sources: ${sources.map((source) => source.provider).join(", ")}`);

for (const file of files) {
	const text = fs.readFileSync(file, "utf8");
	const pick = (pattern: RegExp) => pattern.exec(text)?.[1];
	const schema = pick(/export const USAGE_SOURCE_SCHEMA = "([^"]+)"/);
	const event = pick(/export const USAGE_SOURCE_EVENT = "([^"]+)"/);
	const patternMatch = /const USAGE_SOURCE_PROVIDER_PATTERN = \/([^/]+)\/([a-z]*);/.exec(text);
	const providerPattern = patternMatch ? new RegExp(patternMatch[1] ?? "", patternMatch[2] ?? "") : undefined;
	const ownVersion = pick(/"version": "([^"]+)"/) ?? "";

	console.log(`\n${file}`);
	check("schema", schema === USAGE_SOURCE_SCHEMA, `shell="${schema}" mio="${USAGE_SOURCE_SCHEMA}"`);
	check("event", event === USAGE_SOURCE_EVENT, `shell="${event}" mio="${USAGE_SOURCE_EVENT}"`);
	check("patron de provider", providerPattern !== undefined, `/${patternMatch?.[1] ?? "?"}/${patternMatch?.[2] ?? ""}`);
	for (const source of sources) {
		check(`${source.provider} id`, providerPattern?.test(source.provider) === true, "id dentro del patron del shell");
		check(`${source.provider} fetch`, typeof source.fetch === "function", "fetch es funcion");
		check(`${source.provider} note`, typeof source.pendingNote === "string", `nota: "${source.pendingNote}"`);
	}

	// The gates the validator body actually tests, printed for transparency.
	const body = /export function parseUsageSource\(value: unknown\): UsageSource \| undefined \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? "";
	const gates = body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("if ("))
		.slice(0, 4);
	console.log("  gates del validador:");
	for (const gate of gates) console.log(`    ${gate}`);
}

console.log(`\n${failures === 0 ? "CONTRATO OK" : `${failures} FALLAS`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
