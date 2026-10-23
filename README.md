# pi-commandcode-bridge

A [Pi](https://pi.dev) provider that runs [Command Code](https://commandcode.ai)
models through the **`cmd` CLI** instead of the HTTP Provider API.

Pick it when your Command Code plan can run the CLI but has no API access (the Go
plan, for example), or when you want a Command Code model to orchestrate Pi
subagents from inside `cmd`'s own agent loop.

- Every request is one `cmd -p` run; later turns resume the same `cmd` session.
- Pi tools and subagent orchestration (`subagent_run`) are exposed to `cmd` via
  an ephemeral stdio MCP shim. When called, the turn suspends with `stopReason: "toolUse"`,
  yielding tool execution back to Pi and resuming `cmd` once the result arrives.
- The model list and each model's supported reasoning efforts are **discovered from
  `cmd` itself** and cached, so new models appear without a package update.
- Pi's thinking levels map onto the efforts each model accepts (`xhigh` on a model
  that stops at `max` becomes `max`; models without adjustable effort never get
  `--effort`).

## Why this instead of an API provider

The other Command Code providers for Pi — including the official
`@commandcode/pi-commandcode-provider` — talk to the HTTP **Provider API**. On any
plan with API access that is the simpler choice. But the Command Code docs state
that *"Go is the only plan without API access"*: there the key works for the CLI
only and API providers cannot authenticate at all. This package drives the same
CLI you are already signed in to, so it works on every plan.

| | This package | API-based providers |
| --- | --- | --- |
| Transport | the signed-in `cmd`/`cmdc` CLI | Command Code Provider API (HTTP) |
| Works on the Go plan | yes | no |
| Credentials | none beyond `cmd login` | an API key |
| Model list | discovered live from `cmd --list-models` | read from the API |
| Agent loop | `cmd`'s own (native tools, mods, `cmd` sessions) | Pi's |
| Pi tools inside `cmd`'s loop | bridged over MCP, including `subagent_run` | n/a |

As of this release, the other Command Code packages for Pi on npm
(`@commandcode/pi-commandcode-provider`, `pi-commandcode-provider`,
`@bacnh85/pi-commandcode`, `@arhen/pi-add-commandcode`) all use the HTTP Provider
API; none of them drives the CLI.

Three choices make the difference beyond the transport:

- **Probing instead of static tables.** When `cmd` rejects a bogus `--effort` it
  names the exact levels a model accepts — before calling the model and without
  billing. Discovery records that answer per model, so Pi's thinking levels land
  on values the model really supports and new models work on day one.
- **Pi tools inside `cmd`.** Host Pi tools (such as `subagent_run` or harness
  tools) are bridged into `cmd` through an ephemeral stdio MCP shim, so a Command
  Code model can act as the root orchestrator of Pi subagent sessions (see Tool
  delegation).
- **An honest trade-off.** `cmd` runs its own agent loop and ships its own system
  prompt (about 16,600 input tokens per run); native `cmd` tool activity is shown as
  thinking text (`[cmd tool: ...]`).

If you have API access and do not need `cmd`'s agent loop, an API-based provider is
still the leaner fit: no extra system prompt per run and Pi drives tools directly.

## Requirements

- Pi with extension support.
- The Command Code CLI installed and signed in (`cmd login`; `cmdc` on Windows).
- Node 20+ on `PATH`: the MCP shim that `cmd` spawns runs as a Node script
  (override with `CMDCODE_BRIDGE_SHIM_RUNTIME`).

## Install

```bash
pi install git:github.com/Rommel96/pi-commandcode-bridge # straight from GitHub, no clone needed
pi install npm:pi-commandcode-bridge
pi install /path/to/pi-commandcode-bridge                # from a checkout
```

Do not also define a `commandcode` provider in `~/.pi/agent/models.json`: it
conflicts with this extension.

## Use

```bash
pi --list-models commandcode
pi --model commandcode/z-ai/glm-5.3-flash:high -p "Summarize this repository"
```

Delegating to Pi from a Command Code model (needs a subagent extension that
provides `subagent_run`, such as Gentle Shell):

```bash
pi --model commandcode/xiaomi/mimo-v2.6-pro \
  -p "Use subagent_run to have an explorer map src/, then summarize its report"
```

The model runs inside `cmd`, but `subagent_run` executes in the Pi host, so the
subagent shows up in Pi like any other.

Model ids keep their slashes, so the full reference is
`commandcode/<vendor>/<model>[:<thinking>]`. In Gentle AI profiles use the same
reference, for example `commandcode/xiaomi/mimo-v2.6-pro`.

## Model discovery

1. `cmd --list-models` provides the ids (a context window is read when the
   description states one, such as "1M context"; otherwise 1M applies).
2. For each model, `cmd -p hi -m <id> --effort bogus` is run once. `cmd` rejects the
   value before reaching the model and names the supported levels
   (`Supported: low, high, max.`), or says the model has no adjustable effort. No
   model is called and nothing is billed.
3. The result is cached (24 h) in
   `~/.pi/agent/commandcode-bridge/models-cache.json` (or under `PI_CODING_AGENT_DIR`).

| Situation | Behavior |
| --- | --- |
| No cache | Discovery runs once at startup (about 15 s for ~90 models), then the cache is used |
| Fresh cache | No `cmd` call |
| Stale cache | The cached list is used immediately and a background refresh updates the cache for the next start |
| `cmd` unavailable | A small built-in table is registered |

The background refresh only completes while the host process stays alive, as in an
interactive session. A short one-shot run exits without waiting for it; use
`CMDCODE_BRIDGE_REFRESH=1` for scripts. The list is read when the extension loads,
so new models appear on the next start.

## Tool delegation and subagent orchestration

When a model running through `pi-commandcode-bridge` is used as an orchestrator (e.g. in Gentle-Shell or with Pi subagent extensions), Pi's active tools are exposed to `cmd`:

1. **Ephemeral MCP Server**: The bridge starts an in-process broker and registers an ephemeral stdio MCP shim (`shim.js`) with `cmd` using machine-private local scope (`~/.commandcode/projects/<slug>/mcp.json`).
2. **Suspension & Yielding**: When the model invokes a bridged tool (such as `subagent_run`), the shim forwards the call over a unix socket to the broker and parks the execution. The bridge concludes the Pi turn with `stopReason: "toolUse"` and emits the corresponding `toolCall` events to Pi.
3. **Resumption**: Pi executes the tool (e.g. launching a subagent), returns the output via `toolResult` on the subsequent turn, which unblocks the parked MCP call. `cmd` continues streaming reasoning and final text.
4. **Cleanup**: When the conversation finishes or aborts, the MCP registration and unix socket are removed. If Pi is killed before that, the leftover registration is removed by the next run in the same project once its owning process is gone; registrations of other live Pi sessions are kept.

The broker only serves its own run: every frame must carry a per-run random token,
results go back only to the connection that made the call, and every call must carry
the run's random child nonce. The nonce reaches only the spawned `cmd` process, as
`PICC_BRIDGE_CHILD` in its environment (never in the MCP registration), and `cmd`
passes its environment to the MCP servers it starts, so the shim can prove which run
it belongs to. That check matters because `cmd`'s local MCP scope is shared by every
session in the same project, so a concurrent session's `cmd` also starts this run's
shim. Tool schemas reach the shim through a `0600` file in the run's private temp
directory, not the environment, so large tool sets stay below Linux's 128 KiB
per-string `execve` limit.

Native tools internal to `cmd` (`read_file`, `write_file`, `shell_command`) continue running in-process inside `cmd` and display as thinking blocks (`[cmd tool: ...]`).

`cmd` also ships a built-in `agent` tool. When Pi's `subagent_run` is among the
exposed tools, the bridge generates a small `cmd` mod that blocks `agent` and tells
the model to use the bridged `mcp__<server>__subagent_run` instead, so the subagent
runs in the Pi host and stays visible to the host (for example in Gentle-Shell's
agent list). Set `CMDCODE_BRIDGE_NATIVE_AGENT=allow` to keep `cmd`'s native agents
available and skip the guard.

Task-mode subagents can run for many minutes, so the bridge sets the child's
`MCP_TOOL_TIMEOUT` to at least 30 minutes. The host may also serialize task-mode
subagents; use the tool's background mode when several need to overlap, then collect
them by task id.

## Configuration

| Variable | Purpose |
| --- | --- |
| `CMDCODE_BRIDGE_BIN` | Path of the CLI (default `cmd`, `cmdc` on Windows) |
| `CMDCODE_BRIDGE_YOLO=0` | Do not pass `--yolo` to `cmd` (`--yolo` is on by default, see Limits) |
| `CMDCODE_BRIDGE_MODELS` | Comma separated globs of ids to register, e.g. `deepseek/*,z-ai/*,gpt-6-luna` (default: all) |
| `CMDCODE_BRIDGE_REFRESH=1` | Rediscover now instead of using the cache |
| `CMDCODE_BRIDGE_CACHE` | Cache file path |
| `CMDCODE_BRIDGE_CACHE_TTL_HOURS` | Cache lifetime (default 24) |
| `CMDCODE_BRIDGE_CMD_SKILLS=1` | Let `cmd` discover and list its own skills (skipped by default with `--no-skills`, see Repeated context) |
| `CMDCODE_BRIDGE_COMMIT_ATTRIBUTION=keep` | Keep the `Co-authored-by: CommandCodeBot` commit trailer that `cmd` injects (removed by default, see Commit attribution) |
| `CMDCODE_BRIDGE_NATIVE_AGENT=allow` | Keep `cmd`'s built-in `agent` tool instead of redirecting delegation to Pi's `subagent_run` |
| `CMDCODE_BRIDGE_SHIM_RUNTIME` | Node-compatible runtime used to spawn the MCP shim (default `node`) |
| `CMDCODE_BRIDGE_MCP_TIMEOUT` | Exact MCP timeout in ms for the `cmd` child (default: `1800000` / 30 min) |
| `MCP_TOOL_TIMEOUT` | Lower values are raised to 30 min so long subagent calls survive the model turn plus the subagent execution |

`CMD_HERDR=0` is always set for the child, so `cmd`'s built-in Herdr reporting
cannot replace the agent that Herdr tracks for the Pi pane.

### Commit attribution

`cmd`'s system prompt tells the model to end every git commit message with
`Co-authored-by: CommandCodeBot <noreply@commandcode.ai>`. `cmd` only turns that off
through `"attribution": { "commit": "" }` in a settings file; `--config` rejects the
key, so a provider cannot set it per run. The bridge loads a small `cmd` mod (`--mod`) on every run that
removes exactly that trailer from tool inputs before the tool executes. Other
`Co-authored-by` trailers are never touched. Set
`CMDCODE_BRIDGE_COMMIT_ATTRIBUTION=keep` to leave the trailer in place.

### Repeated context

Pi already sends its own system prompt, skills included, to `cmd`. On top of that
`cmd` adds a catalog of the skills it discovers, so the bridge passes `--no-skills`:
measured on a real run, the first request drops from about 28,100 to 21,800 input
tokens, and the saving repeats on every internal request of a run. Skills passed with
`cmd --skill` still load. Set `CMDCODE_BRIDGE_CMD_SKILLS=1` to keep `cmd`'s catalog.

`cmd` also runs a taste-learning request after every run (one extra model request
that grows with the conversation). It has no per-run switch, and `cmd --config`
saves settings globally, so the bridge leaves it alone. To turn it off yourself, set
`"tasteLearning": false` in `~/.commandcode/config.json` (or in a project's
`.commandcode/settings.local.json`). The `<taste_guidance>` part of `cmd`'s system
prompt stays either way.

## How a request runs

```
cmd -p --output-format json --skip-onboarding --trust -m <model> \
    [--effort <level>] [--resume <session>] [--yolo] [--mod <attribution>] [--no-skills]      (prompt on stdin)
```

`cmd`'s NDJSON stream becomes Pi events: text deltas become text; native `cmd`
tool activity is shown as thinking text (`[cmd tool: ...]`, `[cmd blocked: ...]`)
and never executed by Pi. Tools exposed by the Pi host are bridged the other way
through the ephemeral MCP server (see Tool delegation). Token usage comes from the
last model request of the run. The first request of a Pi conversation sends Pi's
system prompt and the transcript; later ones send only the new messages with
`--resume`. Cancelling terminates the child (SIGTERM, then SIGKILL).

## Limits

- **Native `cmd` tools run internally:** Built-in `cmd` tools (`read_file`, `write_file`, etc.)
  run inside the `cmd` process with `--yolo` and display as thinking; Pi tools and subagents
  are delegated via the bidirectional MCP shim.
- **`cmd` runs with `--yolo` by default**, so install, login and use works without
  extra setup. Every `commandcode` model can write files and run shell commands
  without review. Set `CMDCODE_BRIDGE_YOLO=0` to restore `cmd`'s print-mode
  permission checks; writes and commands are then blocked.
- **Cost per run:** each run carries about 16,600 input tokens of Command Code's own
  system prompt. Prefer fewer, larger requests.
- **Text only:** images are dropped.
- **Sessions bind in memory:** restarting Pi starts new `cmd` conversations.
- `options.onResponse` is not called (a child process has no HTTP response); only
  `onPayload` and `onProviderStreamEvent` are honored.
- **Windows is verified by user report only.** Plain chat works through `cmdc`, and
  tool delegation uses a named pipe (`\\.\pipe\pi-cmd-bridge-<id>`) instead of a unix
  socket. If the broker cannot start, the run continues without Pi tools and says
  why in a thinking block; tool delegation on Windows has not been reproduced by the
  maintainers.
- Prompts, keys and provider payloads are never logged. The cache holds model ids,
  descriptions and effort levels only.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Few or no `commandcode` models | `cmd --list-models`, then `CMDCODE_BRIDGE_REFRESH=1 pi --list-models commandcode` |
| Authentication errors | `cmd status` |
| `has no adjustable reasoning effort` | The model does not accept `--effort`; discovery should have recorded that. Refresh the cache |
| Writes or commands refused | Check `CMDCODE_BRIDGE_YOLO` is not `0` (see Limits) |

## Development

```bash
bun test
```

Tests never call a real model. `tests/fixtures/cmd` and `tests/fixtures/cmd-catalog`
are stub executables; `list-models.txt` and `probes.json` are real `cmd` output.
