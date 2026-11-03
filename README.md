# pi-usage-sources

Gentle Shell usage sources for **OpenCode Go**, **Antigravity** (agy CLI) and
**Claude** (pi-claude-bridge).

Without this extension, the header's `usage` segment and the `alt+u`
Subscriptions panel answer `no subscription usage for this provider` for the
first two providers, forever: gentle-pi ships built-in fetchers only for
`openai-codex`, `anthropic` and `nan`, and no setting changes that. For Claude
the reason is different and worth knowing: gentle-pi's built-in `anthropic`
parser does read the same unified headers the bridge emits, but it always files
them under `anthropic` while the session's provider is `claude-bridge`, which is
the key the bar and the panel look up.

## What it does

Emits `gentle-pi:usage-source/v1` on `pi.events` (the contract documented in
gentle-pi's `docs/gentle-shell.md`, "Extensions can register a usage source"),
one source per provider:

| provider | where the numbers come from |
|---|---|
| `opencode-go` | `GET https://opencode.ai/zen/go/v1/usage`, rolling 5h / weekly / monthly |
| `antigravity` | `agy --print /usage --output-format json`, the Gemini and Claude/GPT pools |
| `claude-bridge` | the `anthropic-ratelimit-unified-*` headers the bridge rebuilds from Claude Code's `rate_limit_event`, 5h and weekly |

A registered source wins over the shell's built-ins for that provider, so the
shell treats these exactly like Codex: same bar, same panel, same gauges.

The agy path is deliberate. It spawns the supported CLI instead of calling the
private quota endpoint that the CLI itself uses, so it needs no Google token of
its own and no `User-Agent` impersonation, and it keeps working when the CLI
works.

The Claude path is deliberate for the same reason. Claude Code makes the calls
and pi-claude-bridge reports what it reported, so this package needs no
Anthropic token, calls no undocumented endpoint, and cannot disagree with what
the subscription actually charged. That also sets its shape: the numbers arrive
with responses, not from a fetch, so the `claude-bridge` source is registered
the first time there is a snapshot to answer with (before that the shell keeps
its own "no subscription usage for this provider" instead of recording a failed
refresh of a provider nothing was ever asked of), and every later snapshot
re-emits the source, which makes the shell refresh that provider at once instead
of waiting out its 5-minute throttle. If a future bridge renamed a window, the
parser finds no percentage for it and the row says it has nothing yet - never a
wrong number.

## Install

```sh
pi install <path-to-this-folder>
# gentle-shell keeps its own home, so install there too:
PI_CODING_AGENT_DIR=<home>/.gentle-shell/agent pi install <path-to-this-folder>
```

A local package is loaded from its resolved path without copying, so editing
this folder changes behaviour after the next pi restart. Remove it with
`pi remove <path>`, or drop the entry from that home's `settings.json`
`packages` list.

Install straight from the repository:

```sh
pi install git:github.com/ashcroft08/pi-usage-sources
```

Requirements on the machine: **pi** with **gentle-pi** (anyone running
gentle-shell has it), plus per provider:

- `opencode-go`: your own `opencode-go` credential in `~/.pi/agent/auth.json`.
  Without it the source reports no data - nothing breaks.
- `antigravity`: the `agy` CLI installed and logged in. If it is not on `PATH`,
  set `AGY_BIN`.
- `claude-bridge`: the `pi-claude-bridge` package installed and Claude Code
  logged into a subscription (`claude` then `/login`). Nothing else: the bridge
  and Claude Code own the account, and the numbers show up from the first Claude
  turn onward.

## Credentials

Nothing is logged, printed, or stored. The OpenCode Go key is read per fetch, in
this order:

1. the credential the shell passes for that provider, when it has one;
2. `$OPENCODE_GO_AUTH` - an exclusive override, always a file path, never a key
   in the environment;
3. `~/.pi/agent/auth.json` - the user's own pi home, which is the reliable one
   because gentle-shell runs every session under its own home
   (`~/.gentle-shell/agent`) and that store carries no `opencode-go` credential;
4. `$PI_CODING_AGENT_DIR/auth.json`.

Antigravity needs no credential here: agy owns the account and the CLI answers
with the session it already has.

The Claude quota needs no credential either. The one thing read from Claude
Code's own store is the **plan label** (`max`, `pro`, ...), and only that field:
`claudeAiOauth.subscriptionType` in `$CLAUDE_CONFIG_DIR/.credentials.json`
(default `~/.claude/.credentials.json`). The OAuth token that sits beside it is
never read, kept, logged, or returned, and there is no way for it to reach the
usage surfaces. `$CLAUDE_CREDENTIALS` is an exclusive override (a file path) for
the same reason `$OPENCODE_GO_AUTH` is. On macOS Claude Code keeps that store in
the Keychain, so the file is simply absent and the label stays empty while the
windows still work.

## Numbers

Percentages are always **used**, never remaining:

- OpenCode Go reports `percent`, which is already usage.
- agy reports `remaining_fraction`, which is what is left, so the source inverts
  it: `usedPercent = (1 - remaining) * 100`.
- Claude reports `utilization` as a fraction on the unified headers, so the
  source multiplies by 100 and clamps to 0-100. A window whose header carries no
  `-utilization` is not a window and is dropped, never defaulted; `status:
  rejected` is what marks the limit reached.
- The endpoint's reset field is `resetsAt` (with the `s`) - reading `resetAt`
  silently drops every reset countdown. That is asserted in the tests. Claude's
  `-reset` headers are Unix **seconds**, so they become milliseconds on the way
  in, which is what the shell's `resets in 4h 12m` countdown reads.
- Window names map to seconds (`5h` -> 18000, `weekly` -> 604800,
  `monthly` -> 2592000) because the bar labels windows by their length.

Claude's windows are the two Claude Code reports: `5h` and `week`. Per-model
caps (`seven_day_opus`, `seven_day_sonnet`) are not on this path - Claude Code
does not put them in the `unifiedWindows` the bridge forwards - so a plan that
has them simply shows the two account windows here.

## Timing

agy answers in ~3s. The shell's own fetch budget is 10s
(`GENTLE_PI_SHELL_USAGE_TIMEOUT_MS`) and a late answer is discarded, so the spawn
gives up at 8s and reports "no data" instead of racing the budget. If agy ever
takes longer, raise the budget where gentle-shell is launched:

```sh
setx GENTLE_PI_SHELL_USAGE_TIMEOUT_MS 30000        # Windows, user environment
export GENTLE_PI_SHELL_USAGE_TIMEOUT_MS=30000      # POSIX shells
```

The shell already throttles automatic refreshes to one per provider per 5
minutes, so no cache lives here; `r` in the panel genuinely re-fetches. The one
exception is Claude, which has nothing to fetch: it shows the last snapshot
Claude Code reported, and a new one re-registers the source so the shell
refreshes that provider immediately instead of waiting out the throttle. Before
the first Claude turn there is nothing to show, and the row keeps the shell's own
note rather than claiming a failed refresh.

One limitation worth knowing: the numbers are reported on a `claude-bridge`
response, so a session that reaches Claude **only** through subagent routes does
not feed the parent panel - those responses belong to the child session, which
meters itself. Switching the session to a Claude model is what puts them on the
bar.

## Verify

```sh
node --experimental-strip-types --test tests/sources.test.ts   # 17 deterministic tests, no network
node verify-live.ts                                           # real accounts, real agy
node verify-contract.ts                                       # the shell's own validator gates
```

`verify-live.ts` prints the current windows and never prints a credential. It
covers the two providers that fetch; the Claude parser is pinned instead against
the real shape, taken from `claude --print --verbose --output-format stream-json`
(CLI 2.1.301), whose `rate_limit_event` is what the bridge rebuilds the headers
from.
`verify-contract.ts` exists because gentle-pi's `lib/shell-usage.ts` cannot be
imported standalone - it imports `@earendil-works/pi-tui`, which Pi injects at
runtime and which is not on disk - so it reads the validator's constants and
gates from the installed copies instead, discovering them from
`$PI_CODING_AGENT_DIR`, `~/.pi/agent`, `~/.gentle-shell/agent` and the global npm
root. Point it anywhere else with `GENTLE_PI_CONTRACT_FILES`.

## Publishing to npm

This package is `private: true` on purpose, so an accidental `npm publish`
cannot happen. To publish it: drop `private`, add `repository`, then run
`npm publish`. The `pi-package` keyword makes it eligible for the Pi package
gallery.

## License

MIT. See [LICENSE](LICENSE).

## Prior art

This is **not** the first usage source for Gentle Shell. The contract
(`gentle-pi:usage-source/v1`, added in gentle-shell #1300) already had
implementations when this package was written, and they cover other providers:

| Project | Registers | Since |
|---|---|---|
| [manutepowa/pi-opencode-go-usage](https://github.com/manutepowa/pi-opencode-go-usage) | `opencode-go` | 2026-09-23 |
| [danielgap/pi-zai-usage](https://github.com/danielgap/pi-zai-usage) | z.ai GLM coding plan | 2026-09-11 |
| [danielgap/pi-claude-usage](https://github.com/danielgap/pi-claude-usage) | Claude via pi-claude-bridge | 2026-10-08 |
| [`@narumitw/pi-usage`](https://www.npmjs.com/package/@narumitw/pi-usage) | several providers | - |

If you only need OpenCode Go, `pi-opencode-go-usage` got there first and is the
older pick for that provider alone.

What this package adds on top of them is **Antigravity through the official `agy`
CLI** - no Google token of its own and no `User-Agent` impersonation - plus the
OpenCode Go reset field that the open built-in pull requests read under the wrong
name (`resetsAt`, not `resetAt`), which is why the built-in path shows a meter
with no reset countdown.

The Claude source is the one place this package overlaps with prior art, and it
takes the other road on purpose. `danielgap/pi-claude-usage` reads Claude Code's
OAuth store and calls `https://api.anthropic.com/api/oauth/usage`, which answers
without waiting for a turn and carries per-model caps; this package reads the
headers `pi-claude-bridge` already rebuilds from the CLI's own
`rate_limit_event`, so it needs no token, no private endpoint and no Keychain
gap, at the cost of only reporting what the CLI reported. Pick whichever trade
you prefer - installing both would register `claude-bridge` twice, and the shell
keeps the most recent registration.
