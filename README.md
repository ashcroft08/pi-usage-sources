# pi-usage-sources

Gentle Shell usage sources for **OpenCode Go** and **Antigravity** (agy CLI).

Without this extension, the header's `usage` segment and the `alt+u`
Subscriptions panel answer `no subscription usage for this provider` for both
providers, forever: gentle-pi ships built-in fetchers only for `openai-codex`,
`anthropic` and `nan`, and no setting changes that.

## What it does

Emits `gentle-pi:usage-source/v1` on `pi.events` (the contract documented in
gentle-pi's `docs/gentle-shell.md`, "Extensions can register a usage source"),
one source per provider:

| provider | where the numbers come from |
|---|---|
| `opencode-go` | `GET https://opencode.ai/zen/go/v1/usage`, rolling 5h / weekly / monthly |
| `antigravity` | `agy --print /usage --output-format json`, the Gemini and Claude/GPT pools |

A registered source wins over the shell's built-ins for that provider, so the
shell treats these exactly like Codex: same bar, same panel, same gauges.

The agy path is deliberate. It spawns the supported CLI instead of calling the
private quota endpoint that the CLI itself uses, so it needs no Google token of
its own and no `User-Agent` impersonation, and it keeps working when the CLI
works.

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

## Numbers

Percentages are always **used**, never remaining:

- OpenCode Go reports `percent`, which is already usage.
- agy reports `remaining_fraction`, which is what is left, so the source inverts
  it: `usedPercent = (1 - remaining) * 100`.
- The endpoint's reset field is `resetsAt` (with the `s`) - reading `resetAt`
  silently drops every reset countdown. That is asserted in the tests.
- Window names map to seconds (`5h` -> 18000, `weekly` -> 604800,
  `monthly` -> 2592000) because the bar labels windows by their length.

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
minutes, so no cache lives here; `r` in the panel genuinely re-fetches.

## Verify

```sh
node --experimental-strip-types --test tests/sources.test.ts   # 9 deterministic tests, no network
node verify-live.ts                                           # real accounts, real agy
node verify-contract.ts                                       # the shell's own validator gates
```

`verify-live.ts` prints the current windows and never prints a credential.
`verify-contract.ts` exists because gentle-pi's `lib/shell-usage.ts` cannot be
imported standalone - it imports `@earendil-works/pi-tui`, which Pi injects at
runtime and which is not on disk - so it reads the validator's constants and
gates from the installed copies instead, discovering them from
`$PI_CODING_AGENT_DIR`, `~/.pi/agent`, `~/.gentle-shell/agent` and the global npm
root. Point it anywhere else with `GENTLE_PI_CONTRACT_FILES`.

## Publishing to npm

This package is `private: true` on purpose, so an accidental `npm publish`
cannot happen. To publish it: drop `private`, add `license`, `repository` and
`author`, then `npm publish`. The `pi-package` keyword makes it eligible for the
Pi package gallery.
