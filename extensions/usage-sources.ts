// Gentle Shell usage sources for OpenCode Go, Antigravity and Claude.
//
// The shell (gentle-pi) consumes `gentle-pi:usage-source/v1` from `pi.events`;
// this extension only builds the sources and hands them over. Registering
// again for the same provider replaces the previous source, so registering on
// every session start is safe, and the load-time registration covers a load
// that happens after a session already started.
//
// Claude is the one source fed by events instead of a fetch: pi-claude-bridge
// rebuilds Anthropic's unified rate-limit headers from Claude Code's
// `rate_limit_event` and hands them to `after_provider_response`. It is
// registered only once there is a snapshot to answer with.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSources, createClaudeBridgeSource, CLAUDE_BRIDGE_PROVIDER, USAGE_SOURCE_EVENT, type SourceDeps, type UsageSource } from "../src/sources.ts";

export default function usageSources(pi: ExtensionAPI, deps: SourceDeps = {}): void {
	const claudeBridge = createClaudeBridgeSource(deps.claudeBridge);
	const now = deps.now ?? (() => Date.now());
	const emit = (source: UsageSource) => pi.events.emit(USAGE_SOURCE_EVENT, source);
	const register = () => {
		for (const source of buildSources(deps)) emit(source);
		if (claudeBridge.hasSnapshot()) emit(claudeBridge.source);
	};
	register();
	pi.on("session_start", register);
	// The bridge's header names are the real Anthropic API's, so only the active
	// provider says whose numbers these are: a native `anthropic` response is
	// already metered by the shell's own parser, and capturing it here would put
	// API billing under the subscription's row.
	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider !== CLAUDE_BRIDGE_PROVIDER) return;
		// A new snapshot is re-emitted so the shell forces its own refresh for
		// this provider instead of waiting out its 5-minute throttle.
		if (claudeBridge.capture(event.headers, now())) emit(claudeBridge.source);
	});
}
