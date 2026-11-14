// JSON entry point: the same subscription usage the shell's alt+u panel shows,
// as one versioned document a program can parse. No pi runtime and no TUI,
// which is what lets an app outside pi render it.
//   node usage-json.ts
//
// stdout carries the document and nothing else. Exit 0 means a document was
// printed, even when every provider failed: the reader decides from the
// statuses. A non-zero exit means no document at all.
import { buildSources } from "./src/sources.ts";
import { collectUsageJson, serializeUsageJson, shortReason } from "./src/usage-json.ts";

try {
	const document = await collectUsageJson(buildSources({}));
	process.stdout.write(serializeUsageJson(document));
} catch (error) {
	// The only failure is a document that could not be built: a provider that
	// failed is a status inside the document.
	process.stderr.write(`usage-json: cannot build the document: ${shortReason(error)}\n`);
	process.exitCode = 1;
}
