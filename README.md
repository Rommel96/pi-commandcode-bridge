# pi-commandcode-bridge

A [Pi](https://pi.dev) model provider that runs every request through the
Command Code CLI (`cmd -p`). Use models like
`commandcode/deepseek/deepseek-v4.1-flash:max` in Pi, including in subagents
(`pi --model commandcode/<model-id>:<thinking> ...`).

The Command Code plan blocks the HTTP Provider API, so the CLI is the only
allowed path: one Pi request spawns one `cmd -p` run and streams its NDJSON
back into Pi.

## Install

From a local checkout:

```bash
pi install ./pi-commandcode-bridge
```

Or try it for one invocation:

```bash
pi --extension /Users/dev/dev/utils/pi-commandcode-bridge
```

Register the package in `~/.pi/agent/settings.json` (or `.pi/settings.json`
with `pi install --local`) for permanent use. Verify registration with:

```bash
pi --extension /Users/dev/dev/utils/pi-commandcode-bridge --list-models commandcode
```

## Models

| Model id | `cmd --effort` levels | Thinking |
|---|---|---|
| `deepseek/deepseek-v4.1-flash` | `off`, `low`, `high`, `max` | yes |
| `xiaomi/mimo-v2.6-pro` | none | no |
| `gpt-6-luna` | `low`, `medium`, `high`, `xhigh`, `max` | yes |

- Context window 1,000,000 tokens; cost is always 0 (the plan pays).
- Pi thinking levels that a model does not support are hidden in the toggle,
  but a requested hidden level is still clamped to the nearest supported
  effort (ties round up: `medium` on DeepSeek sends `--effort high`,
  `minimal` sends `--effort low`, `xhigh` sends `--effort max`).
- `--effort` is omitted entirely for `xiaomi/mimo-v2.6-pro` and when no
  thinking level was requested.

## Environment variables

| Variable | Effect |
|---|---|
| `CMDCODE_BRIDGE_BIN` | `cmd` binary to spawn (default: `cmd` on `PATH`) |
| `CMDCODE_BRIDGE_YOLO=1` | Pass `--yolo` to `cmd` (default: off) |
| `CMD_HERDR` | Always forced to `0` in the child, so `cmd`'s built-in Herdr reporting cannot replace a wrapper |

## How a request runs

One Pi request = one `cmd` run:

```text
cmd -p <prompt> --output-format json --skip-onboarding --trust \
    -m <model-id> [--effort E] [--resume SID] [--yolo]
```

- cwd is the Pi process working directory; stdin is ignored; the child
  environment is inherited (plus `CMD_HERDR=0`).
- Each Pi conversation is bound to one `cmd` session (kept in memory for the
  lifetime of the Pi process). The first run sends the Pi system prompt, a
  plain-text transcript of prior messages and the latest user message; later
  runs pass `--resume <sessionId>` and send only the new user/tool-result
  text.
- `text_delta` events stream as text; `tool_queued`/`tool_hook_blocked`
  events appear as thinking text such as `[cmd tool: write_file /path]` and
  `[cmd blocked: write_file: <reason>]`.
- Token usage is mapped from the `result` line (cost stays 0).

## Limits and caveats

- **`cmd` uses its own tools.** Pi tool definitions are never executed and the
  provider never emits Pi tool calls; `cmd` runs its own closed tool loop.
  Tool activity is only visible as thinking text.
- **~16.6k input tokens per run.** Every `cmd` run carries Command Code's own
  system prompt (~16,600 tokens), on top of the prompt this bridge sends.
- **`--yolo` risk.** In `-p` mode `cmd` blocks file writes and shell commands
  unless `--yolo` is passed. Enabling `CMDCODE_BRIDGE_YOLO=1` lets `cmd`
  modify the working tree with no approval gate; leave it off unless you
  accept that risk.
- **MiMo has no effort.** `xiaomi/mimo-v2.6-pro` has no adjustable reasoning
  effort; `cmd` exits 1 with "MiMo V2.6 Pro has no adjustable reasoning
  effort." if any `--effort` is passed, so this bridge never sends one.
- **Text only.** The `cmd -p` prompt is plain text; image input is not
  forwarded.
- **Session bindings are in-memory.** A Pi restart starts fresh `cmd`
  conversations (a stable hash of the system prompt plus first user message is
  used when Pi provides no session id).
- **`options.onResponse` is not called.** Pi's provider contract includes an
  `onResponse` hook for HTTP responses; a child process has no HTTP response,
  so only `onPayload` and `onProviderStreamEvent` are honored.
- Prompts, keys and provider payloads are never logged to disk.

## Development

```bash
bun test
```

Tests never call the real `cmd`: they use a stub executable
(`tests/fixtures/cmd`) that records its argv/environment and prints scripted
NDJSON.
