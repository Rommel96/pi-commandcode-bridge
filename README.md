# pi-commandcode-bridge

A [Pi](https://pi.dev) provider that runs [Command Code](https://commandcode.ai)
models through the **`cmd` CLI** instead of the HTTP Provider API.

Pick it when your Command Code plan can run the CLI but has no API access (the Go
plan, for example). If you have API access, the API-based providers are simpler.

- Every request is one `cmd -p` run; later turns resume the same `cmd` session.
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

Two choices make the difference beyond the transport:

- **Probing instead of static tables.** When `cmd` rejects a bogus `--effort` it
  names the exact levels a model accepts — before calling the model and without
  billing. Discovery records that answer per model, so Pi's thinking levels land
  on values the model really supports and new models work on day one.
- **An honest trade-off.** `cmd` runs its own agent loop and ships its own system
  prompt (about 16,600 input tokens per run); its tool activity is shown as text
  and Pi tools are not available to these models. That is the cost of running
  without API access (see Limits).

If you have API access, an API-based provider is still the better fit there: no
extra system prompt per run and Pi's own tools work. Use this one where the API
does not.

## Requirements

- Pi with extension support.
- The Command Code CLI installed and signed in (`cmd login`; `cmdc` on Windows).
- Node 20+ (the extension uses only Node APIs).

## Install

```bash
pi install git:github.com/Rommel96/pi-commandcode-bridge # straight from GitHub, no clone needed
pi install npm:pi-commandcode-bridge                     # once published
pi install /path/to/pi-commandcode-bridge                # from a checkout
```

Do not also define a `commandcode` provider in `~/.pi/agent/models.json`: it
conflicts with this extension.

## Use

```bash
pi --list-models commandcode
pi --model commandcode/z-ai/glm-5.3-flash:high -p "Summarize this repository"
```

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

## Configuration

| Variable | Purpose |
| --- | --- |
| `CMDCODE_BRIDGE_BIN` | Path of the CLI (default `cmd`, `cmdc` on Windows) |
| `CMDCODE_BRIDGE_YOLO=0` | Do not pass `--yolo` to `cmd` (`--yolo` is on by default, see Limits) |
| `CMDCODE_BRIDGE_MODELS` | Comma separated globs of ids to register, e.g. `deepseek/*,z-ai/*,gpt-6-luna` (default: all) |
| `CMDCODE_BRIDGE_REFRESH=1` | Rediscover now instead of using the cache |
| `CMDCODE_BRIDGE_CACHE` | Cache file path |
| `CMDCODE_BRIDGE_CACHE_TTL_HOURS` | Cache lifetime (default 24) |

`CMD_HERDR=0` is always set for the child, so `cmd`'s built-in Herdr reporting
cannot replace the agent that Herdr tracks for the Pi pane.

## How a request runs

```
cmd -p --output-format json --skip-onboarding --trust -m <model> \
    [--effort <level>] [--resume <session>] [--yolo]      (prompt on stdin)
```

`cmd`'s NDJSON stream becomes Pi events: text deltas become text; tool activity is
shown as thinking text (`[cmd tool: ...]`, `[cmd blocked: ...]`) and is never executed
by Pi; token usage comes from the last model request of the run. The first request of
a Pi conversation sends Pi's system prompt and the transcript; later ones send only the
new messages with `--resume`. Cancelling terminates the child (SIGTERM, then SIGKILL).

## Limits

- **`cmd` runs its own agent loop and its own tools.** Pi tools, MCP tools and Pi
  tool calls are not available to these models; output is text.
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
- **Windows is untested.**
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
