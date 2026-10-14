---
name: commandcode-low-cost
description: "Trigger: low-cost profile, commandcode/<id>:<level>, Command Code, cmd models, delegating to cmd. Drive the commandcode provider bridge."
license: Apache-2.0
metadata:
  author: "Rommel96"
  version: "1.0"
---

## Activation Contract

Load for the `low-cost` Gentle AI profile, model refs `commandcode/<id>:<level>`, Command Code / `cmd` models, or delegating to `cmd`.

## Hard Rules

- One Pi request = one `cmd -p` run (prompt on stdin); later turns resume the same `cmd` session. The Command Code Go plan has no HTTP API: CLI only.
- `cmd` uses its OWN tools: no Pi tools, MCP tools or Pi tool calls in these roles; output is text. Never claim Pi-side tool execution.
- Never send `--effort` for `xiaomi/mimo-v2.6-pro` (the bridge omits it).
- `cmd` cannot write files or run shell commands unless the Pi process runs with `CMDCODE_BRIDGE_YOLO=1` (`--yolo`, no per-action review). It is process-wide: every `commandcode` role launched from that Pi process inherits it, so enable it only for sessions where every role may edit.
- `~/.pi/agent/models.json` must NOT define a `commandcode` provider (conflicts with the extension).
- Images are dropped; session bindings are in-memory (a Pi restart starts a new `cmd` conversation).

## Decision Gates

| Model ref | Effort | `low-cost` roles |
|---|---|---|
| `deepseek/deepseek-v4.1-flash` | off, low, high, max | orchestrator, jd-judge-b, jd-fix-agent (`:max`) |
| `gpt-6-luna` | low..max | gentle-ai-explore, review-readability (`:xhigh`) |
| `xiaomi/mimo-v2.6-pro` | none | worker, verify, review-reliability, review-resilience, review-risk, review-refuter, review-validator, jd-judge-a (`:max`) |

Prefer few, large tasks: each run adds ~16,600 input tokens of Command Code system prompt, MiMo is slow (~1h per large task), and credits come from the plan.

| Symptom | Action |
|---|---|
| <3 models in `pi --list-models commandcode` | extension not loaded |
| auth error | run `cmd status` |
| "has no adjustable reasoning effort" | `--effort` reached MiMo: bridge bug |
| Herdr conflict | bridge sets `CMD_HERDR=0`; never override |

## Execution Steps

1. Activate: `/gentle:profiles`, Enter on `low-cost`, or pin a repository (`p` / `P`).
2. Route roles per the table; keep `commandcode/<id>:<level>` refs verbatim.
3. Before delegating file edits, confirm the Pi process was started with `CMDCODE_BRIDGE_YOLO=1`; otherwise report that edits will be blocked.
4. Ad-hoc delegation outside profile roles: `cmd-agent start` / `cmd-agent prompt` in a Herdr pane (see References).
5. On anomalies, run the symptom checks and report exactly what you saw.

## Output Contract

Report the model ref used, whether `--yolo` was active, and error tails verbatim.

## References

- `/Users/dev/dev/utils/cmd-herdr-agent/README.md` — ad-hoc `cmd-agent` Herdr delegation.
- `/Users/dev/dev/utils/pi-commandcode-bridge/README.md` — bridge install, env variables, limits.
