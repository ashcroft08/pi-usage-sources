// Gentle Shell usage sources for OpenCode Go and Antigravity.
//
// The shell (gentle-pi) consumes `gentle-pi:usage-source/v1` from `pi.events`;
// this extension only builds the two sources and hands them over. Registering
// again for the same provider replaces the previous source, so registering on
// every session start is safe, and the load-time registration covers a load
// that happens after a session already started.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSources, USAGE_SOURCE_EVENT, type SourceDeps } from "../src/sources.ts";

export default function usageSources(pi: ExtensionAPI, deps: SourceDeps = {}): void {
	const register = () => {
		for (const source of buildSources(deps)) pi.events.emit(USAGE_SOURCE_EVENT, source);
	};
	register();
	pi.on("session_start", register);
}
