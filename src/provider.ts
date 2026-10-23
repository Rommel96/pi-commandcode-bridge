import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type ToolCall,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { attributionArgs } from "./attribution.js";
import { resolveBin } from "./bin.js";
import { resolveLaunch } from "./launch.js";
import { specFor, toCmdEffort } from "./models.js";
import { buildDeltaPrompt, buildInitialPrompt, messageText } from "./prompt.js";
import {
	openBroker,
	resultToMcpContent,
	type Broker,
	type BrokerCall,
} from "./mcp/broker.js";
import {
	mcpServerName,
	MCP_NAME_PREFIX,
	registerMcpServer,
	unregisterMcpServer,
	removeStaleBridgeServers,
} from "./mcp/register.js";
import { matchToolResult } from "./mcp/results.js";
import { writeSteeringMod } from "./mcp/steering.js";

/** The provider request payload passed to `options.onPayload` (spec R6). */
export interface CmdPayload {
	/** Full child argv; the prompt is not part of it (F2: it travels on stdin). */
	argv: string[];
	/** The prompt sent to `cmd` on stdin. */
	prompt: string;
}

const STDERR_TAIL_CHARS = 2000;
const SIGKILL_DELAY_MS = 5000;

/** In-memory Pi conversation -> `cmd` session binding (spec R5). */
const bindings = new Map<string, { cmdSessionId: string }>();

interface BlockState {
	partial: AssistantMessage;
	textIdx: number | null;
	thinkingIdx: number | null;
	started: boolean;
}

interface ActiveSession {
	key: string;
	child: ReturnType<typeof spawn>;
	broker: Broker;
	serverName: string;
	bin: string;
	env: Record<string, string>;
	cwd: string;
	stream: AssistantMessageEventStream;
	blocks: BlockState;
	finalize: (reason: "stop" | "error" | "aborted" | "toolUse", errorMessage?: string) => void;
	options?: SimpleStreamOptions;
	killTimer?: ReturnType<typeof setTimeout>;
	toolUseTimer?: ReturnType<typeof setTimeout>;
	turnFinished: boolean;
	closed: boolean;
}

const activeSessions = new Map<string, ActiveSession>();

/** Custom `streamSimple` driving one `cmd -p` run per Pi request (spec R4-R6, issue #1). */
export function streamSimple(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void runCmdTurn(stream, model, context, options);
	return stream;
}

async function runCmdTurn(
	stream: AssistantMessageEventStream,
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): Promise<void> {
	const blocks: BlockState = {
		partial: newAssistant(model),
		textIdx: null,
		thinkingIdx: null,
		started: false,
	};
	let finished = false;

	const key = conversationKey(context, options);
	const tools = getCurrentTools(context.messages);

	// -------------------------------------------------------------------------
	// 1. Check for an active suspended session awaiting tool results
	// -------------------------------------------------------------------------
	const existing = activeSessions.get(key);
	if (existing && !existing.closed) {
		if (existing.broker.pending.length > 0) {
			const toolResults = context.messages.filter(
				(m): m is Extract<Message, { role: "toolResult" }> => m.role === "toolResult",
			);
			const hasMatchingResult = existing.broker.pending.some(
				(call) => matchToolResult(call, existing.broker.pending, toolResults) !== undefined,
			);
			if (!hasMatchingResult) {
				// Turn arrived without tool results: supersede previous run
				existing.closed = true;
				activeSessions.delete(key);
				try {
					existing.child.kill("SIGTERM");
				} catch {
					/* already gone */
				}
				existing.broker.close();
				void unregisterMcpServer(existing.bin, existing.env, existing.serverName, existing.cwd);
			} else {
				// Re-attach to the suspended session
				for (const call of [...existing.broker.pending]) {
					const match = matchToolResult(call, existing.broker.pending, toolResults);
					if (match) {
						existing.broker.respond(call.id, {
							content: resultToMcpContent(match.content),
							isError: match.isError,
						});
					}
				}

				existing.stream = stream;
				existing.blocks = blocks;
				existing.options = options;
				existing.turnFinished = false;

				const turnFinalize = (reason: "stop" | "error" | "aborted" | "toolUse", errorMessage?: string): void => {
					if (existing.turnFinished) return;
					existing.turnFinished = true;
					closeText(stream, blocks);
					closeThinking(stream, blocks);
					if (reason === "toolUse") {
						blocks.partial.stopReason = "toolUse";
						stream.push({ type: "done", reason: "toolUse", message: blocks.partial });
					} else {
						existing.closed = true;
						activeSessions.delete(key);
						existing.broker.close();
						void unregisterMcpServer(existing.bin, existing.env, existing.serverName, existing.cwd);
						if (reason === "stop") {
							blocks.partial.stopReason = "stop";
							stream.push({ type: "done", reason: "stop", message: blocks.partial });
						} else {
							blocks.partial.stopReason = reason;
							blocks.partial.errorMessage = errorMessage ?? "cmd run failed";
							stream.push({ type: "error", reason, error: blocks.partial });
						}
					}
					stream.end();
				};
				existing.finalize = turnFinalize;

				const signal = options?.signal;
				if (signal?.aborted) {
					turnFinalize("aborted", "Operation aborted");
					try {
						existing.child.kill("SIGTERM");
					} catch {
						/* already gone */
					}
					return;
				}
				if (signal) {
					signal.addEventListener(
						"abort",
						() => {
							turnFinalize("aborted", "Operation aborted");
							try {
								existing.child.kill("SIGTERM");
							} catch {
								/* already gone */
							}
						},
						{ once: true },
					);
				}
				return;
			}
		}
	}

	// -------------------------------------------------------------------------
	// 2. Start a fresh run
	// -------------------------------------------------------------------------
	const bound = bindings.get(key);
	const spec = specFor(model.id);
	const effort = toCmdEffort(options?.reasoning, spec?.efforts ?? []);
	const prompt = bound
		? buildDeltaPrompt(context.messages)
		: buildInitialPrompt(
				getCurrentSystemPrompt(context.messages),
				priorMessages(context.messages),
				latestUserText(context.messages),
			);

	const argv = [
		"-p",
		"--output-format",
		"json",
		"--skip-onboarding",
		"--trust",
		"-m",
		model.id,
		...(effort ? ["--effort", effort] : []),
		...(bound ? ["--resume", bound.cmdSessionId] : []),
	];

	const env = childEnv(options);
	const bin = resolveBin(env);
	// On by default so print mode can run tools; CMDCODE_BRIDGE_YOLO=0 opts out.
	if (env.CMDCODE_BRIDGE_YOLO !== "0") argv.push("--yolo");
	// Strips cmd's injected "Co-authored-by: CommandCodeBot" commit trailer.
	argv.push(...attributionArgs(env));
	// Pi already hands cmd its own skills in the system prompt; cmd's catalog
	// repeats ~6K tokens per request. CMDCODE_BRIDGE_CMD_SKILLS=1 keeps it.
	if (env.CMDCODE_BRIDGE_CMD_SKILLS !== "1") argv.push("--no-skills");

	let payload: CmdPayload = { argv, prompt };
	if (options?.onPayload) {
		const replacement = await options.onPayload(payload, model);
		if (replacement !== undefined && replacement !== null) {
			payload = replacement as CmdPayload;
		}
	}

	const finalize = (reason: "stop" | "error" | "aborted" | "toolUse", errorMessage?: string): void => {
		const sess = activeSessions.get(key);
		if (sess ? sess.turnFinished : finished) return;
		if (sess) sess.turnFinished = true;
		finished = true;
		closeText(stream, blocks);
		closeThinking(stream, blocks);
		if (reason === "toolUse") {
			blocks.partial.stopReason = "toolUse";
			stream.push({ type: "done", reason: "toolUse", message: blocks.partial });
		} else {
			if (sess) {
				sess.closed = true;
				activeSessions.delete(key);
				sess.broker.close();
				void unregisterMcpServer(bin, env, sess.serverName, sess.cwd);
			}
			if (reason === "stop") {
				blocks.partial.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: blocks.partial });
			} else {
				blocks.partial.stopReason = reason;
				blocks.partial.errorMessage = errorMessage ?? "cmd run failed";
				stream.push({ type: "error", reason, error: blocks.partial });
			}
		}
		stream.end();
	};

	const signal = options?.signal;
	if (signal?.aborted) {
		finalize("aborted", "Operation aborted");
		return;
	}

	const cwd = process.cwd();
	let broker: Broker | undefined;
	let spawnEnv = env;
	let serverName = "";

	if (tools.length > 0) {
		await removeStaleBridgeServers(bin, env, cwd);
		serverName = mcpServerName(key);
		try {
			broker = await openBroker({
				tools,
				// Documented override for troubleshooting and tests (README, Configuration).
				endpoint: env.CMDCODE_BRIDGE_BROKER_ENDPOINT || undefined,
				onCall: (call) => {
					const sess = activeSessions.get(key);
					if (!sess || sess.closed) return;
					appendToolCall(sess.stream, sess.blocks, call);
					if (sess.toolUseTimer) clearTimeout(sess.toolUseTimer);
					sess.toolUseTimer = setTimeout(() => {
						sess.finalize("toolUse");
					}, 25);
				},
			});
		} catch (error) {
			// A broker that cannot listen must not take the host down: this run
			// continues without bridged Pi tools and says why once.
			appendThinking(
				stream,
				blocks,
				`[bridge: Pi tools unavailable this run: ${(error as Error).message}]`,
			);
		}

		if (broker) {
			const shimCfg = broker.shimCommand();
			const reg = await registerMcpServer(
				bin,
				env,
				serverName,
				{ transport: "stdio", command: shimCfg.command, args: shimCfg.args, env: shimCfg.env },
				cwd,
			);
			if (!reg.ok) {
				broker.close();
				finalize("error", `cannot register bridge MCP server: ${reg.error}`);
				return;
			}

			// cmd always exposes its native `agent` tool, and it wins over the MCP
			// subagent_run often enough to be a problem: that subagent runs inside
			// cmd, so the Pi host never sees it. Block it with a generated mod and
			// hand the model the exact MCP name to use instead. Users who prefer
			// cmd's native agents can opt out with CMDCODE_BRIDGE_NATIVE_AGENT=allow.
			if (tools.some((tool) => tool.name === "subagent_run") && env.CMDCODE_BRIDGE_NATIVE_AGENT !== "allow") {
				try {
					const modPath = writeSteeringMod(broker.dir, serverName);
					payload = { ...payload, argv: [...payload.argv, "--mod", modPath] };
				} catch (error) {
					broker.close();
					void unregisterMcpServer(bin, env, serverName, cwd);
					finalize("error", `cannot write delegation guard: ${(error as Error).message}`);
					return;
				}
			}

			// Only the spawned cmd child carries the nonce; cmd passes its env to
			// the MCP servers it starts, so the shim can prove which run it serves.
			spawnEnv = { ...env, PICC_BRIDGE_CHILD: broker.childNonce };
		}
	}

	let child;
	try {
		const launch = resolveLaunch(bin, spawnEnv);
		child = spawn(launch.command, [...launch.args, ...payload.argv], {
			cwd,
			env: spawnEnv,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		if (broker) {
			broker.close();
			void unregisterMcpServer(bin, env, serverName, cwd);
		}
		finalize("error", `cannot start cmd: ${(error as Error).message}`);
		return;
	}

	if (broker) {
		const session: ActiveSession = {
			key,
			child,
			broker,
			serverName,
			bin,
			env,
			cwd,
			stream,
			blocks,
			finalize,
			options,
			turnFinished: false,
			closed: false,
		};
		activeSessions.set(key, session);
	}

	// The prompt travels on stdin (F2): argv space is far too small for a
	// system prompt plus transcript.
	child.stdin?.on("error", () => {
		/* child may exit before consuming the prompt */
	});
	child.stdin?.end(payload.prompt);

	let stderrTail = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => {
		stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
	});

	let lineBuffer = "";
	let processing: Promise<void> = Promise.resolve();
	let resultLine: Record<string, any> | null = null;
	let lastRequestUsage: Record<string, unknown> | undefined;
	let runSessionId: string | undefined;

	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		lineBuffer += chunk;
		const lines: string[] = [];
		let nl = lineBuffer.indexOf("\n");
		while (nl >= 0) {
			lines.push(lineBuffer.slice(0, nl));
			lineBuffer = lineBuffer.slice(nl + 1);
			nl = lineBuffer.indexOf("\n");
		}
		if (lines.length === 0) return;
		processing = processing.then(() => processLines(lines));
	});

	const processLines = async (lines: string[]): Promise<void> => {
		const sess = activeSessions.get(key);
		const curStream = sess ? sess.stream : stream;
		const curBlocks = sess ? sess.blocks : blocks;
		const curOptions = sess ? sess.options : options;

		for (const raw of lines) {
			const line = raw.trim();
			if (!line) continue;
			let parsed: Record<string, any>;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			await curOptions?.onProviderStreamEvent?.(parsed, model);
			if (sess ? sess.turnFinished : finished) continue;
			if (parsed.type === "result") {
				resultLine = parsed;
				continue;
			}
			const event = parsed.event;
			if (!event || typeof event !== "object") continue;
			switch (event.type) {
				case "run_start":
					runSessionId = event.sessionId ?? runSessionId;
					break;
				case "model_request_end":
					// result.usage is the SUM over every internal request of the
					// run; only the last request reflects the context size (F1).
					if (event.usage && typeof event.usage === "object") {
						lastRequestUsage = event.usage;
					}
					break;
				case "text_delta":
					appendText(curStream, curBlocks, String(event.delta ?? ""));
					break;
				case "tool_queued": {
					const toolName = String(event.toolName ?? "tool");
					// cmd names MCP tools `mcp__<server>__<tool>` with the server name verbatim.
					if (serverName && toolName.startsWith(`mcp__${MCP_NAME_PREFIX}`)) {
						// Bridged MCP tool: will be handled via broker onCall
						break;
					}
					appendThinking(
						curStream,
						curBlocks,
						`[cmd tool: ${toolName} ${formatToolDetail(event.input)}]`,
					);
					break;
				}
				case "tool_hook_blocked":
					appendThinking(
						curStream,
						curBlocks,
						`[cmd blocked: ${event.toolName ?? "tool"}: ${String(event.hookOutput ?? "").trim()}]`,
					);
					break;
				default:
					break;
			}
		}
	};

	let killTimer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = (): void => {
		try {
			child.kill("SIGTERM");
		} catch {
			/* already gone */
		}
		killTimer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}, SIGKILL_DELAY_MS);
		finalize("aborted", "Operation aborted");
	};
	if (signal) signal.addEventListener("abort", onAbort, { once: true });

	child.on("error", (error: Error) => {
		finalize("error", `cannot start cmd: ${error.message}`);
	});
	child.on("spawn", () => {
		const sess = activeSessions.get(key);
		const curStream = sess ? sess.stream : stream;
		const curBlocks = sess ? sess.blocks : blocks;
		if (!finished) ensureStarted(curStream, curBlocks);
	});
	child.on("close", (code: number | null) => {
		if (killTimer) clearTimeout(killTimer);
		signal?.removeEventListener("abort", onAbort);
		void (async () => {
			await processing;
			const sess = activeSessions.get(key);
			const curStream = sess ? sess.stream : stream;
			const curBlocks = sess ? sess.blocks : blocks;
			const curFinalize = sess ? sess.finalize : finalize;

			const ok = code === 0 && resultLine !== null && resultLine.subtype === "success";
			if (ok) {
				const sessionId = resultLine.sessionId ?? runSessionId;
				if (sessionId) bindings.set(key, { cmdSessionId: sessionId });
				// F3: a run that emitted only thinking must still surface
				// finalText as text before done.
				const finalText = typeof resultLine.finalText === "string" ? resultLine.finalText : "";
				const hasText = curBlocks.partial.content.some(
					(b) => b.type === "text" && b.text.length > 0,
				);
				if (!hasText && finalText) {
					appendText(curStream, curBlocks, finalText);
				}
				curBlocks.partial.usage = toPiUsage(lastRequestUsage ?? resultLine.usage);
				curFinalize("stop");
				return;
			}
			const exitDesc = code === null ? "killed" : `exit ${code}`;
			let message = resultLine ? `cmd failed (${exitDesc})` : `cmd produced no result (${exitDesc})`;
			const tail = stderrTail.trim();
			if (tail) message += `\n${tail}`;
			curFinalize("error", message);
		})();
	});
}

/** Stable conversation key: the stream's session id, else a hash of system prompt + first user message (spec R5). */
function conversationKey(context: TranscriptContext, options?: SimpleStreamOptions): string {
	const sid = options?.sessionId;
	if (sid && sid.length > 0) return `sid:${sid}`;
	const firstUser = context.messages.find((m) => m.role === "user");
	const digest = createHash("sha256")
		.update(getCurrentSystemPrompt(context.messages))
		.update("\0")
		.update(firstUser ? messageText(firstUser) : "")
		.digest("hex");
	return `hash:${digest}`;
}

/** All messages except system messages and the trailing user message. */
function priorMessages(messages: readonly Message[]): Message[] {
	const last = messages[messages.length - 1];
	const out: Message[] = [];
	for (const message of messages) {
		if (message.role === "system") continue;
		if (message === last && message.role === "user") continue;
		out.push(message);
	}
	return out;
}

function latestUserText(messages: readonly Message[]): string {
	const last = messages[messages.length - 1];
	return last && last.role === "user" ? messageText(last) : "";
}

/** Inherited environment plus provider-scoped overrides; CMD_HERDR=0 always wins (spec R4). */
function childEnv(options?: SimpleStreamOptions): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined) env[name] = value;
	}
	if (options?.env) {
		for (const [name, value] of Object.entries(options.env)) {
			if (value !== undefined) env[name] = value;
		}
	}
	env.CMD_HERDR = "0";
	// A task-mode subagent_run can outlive cmd's 80s MCP default by many
	// minutes, and Pi may pass its own MCP_TOOL_TIMEOUT through options.env.
	// Raise the value instead of only filling it in when absent; the bridge
	// variable is the exact override for callers that need a different bound.
	const bridgeTimeout = Number(env.CMDCODE_BRIDGE_MCP_TIMEOUT);
	if (Number.isFinite(bridgeTimeout) && bridgeTimeout > 0) {
		env.MCP_TOOL_TIMEOUT = String(bridgeTimeout);
	} else {
		const ambient = Number(env.MCP_TOOL_TIMEOUT);
		const minimum = 1_800_000;
		env.MCP_TOOL_TIMEOUT = String(
			Number.isFinite(ambient) && ambient > 0 ? Math.max(ambient, minimum) : minimum,
		);
	}
	return env;
}

function formatToolDetail(input: unknown): string {
	if (input && typeof input === "object" && typeof (input as { path?: unknown }).path === "string") {
		return (input as { path: string }).path;
	}
	return JSON.stringify(input ?? {});
}

/**
 * Map `cmd` usage to Pi usage. `cmd`'s inputTokens already includes cache
 * reads, so Pi input excludes them (F1); totalTokens counts every token once.
 */
function toPiUsage(usage: Record<string, unknown> | undefined): Usage {
	const inputTokens = Number(usage?.inputTokens ?? 0) || 0;
	const output = Number(usage?.outputTokens ?? 0) || 0;
	const cacheRead = Number(usage?.cacheReadTokens ?? 0) || 0;
	const cacheWrite = Number(usage?.cacheWriteTokens ?? 0) || 0;
	const input = Math.max(0, inputTokens - cacheRead);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function newAssistant(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

function ensureStarted(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.started) return;
	b.started = true;
	stream.push({ type: "start", partial: b.partial });
}

function appendText(stream: AssistantMessageEventStream, b: BlockState, delta: string): void {
	ensureTextOpen(stream, b);
	textAt(b.partial, b.textIdx as number).text += delta;
	stream.push({ type: "text_delta", contentIndex: b.textIdx as number, delta, partial: b.partial });
}

function appendThinking(stream: AssistantMessageEventStream, b: BlockState, delta: string): void {
	ensureThinkingOpen(stream, b);
	thinkingAt(b.partial, b.thinkingIdx as number).thinking += delta;
	stream.push({
		type: "thinking_delta",
		contentIndex: b.thinkingIdx as number,
		delta,
		partial: b.partial,
	});
}

function appendToolCall(stream: AssistantMessageEventStream, b: BlockState, call: BrokerCall): void {
	closeText(stream, b);
	closeThinking(stream, b);
	ensureStarted(stream, b);
	const toolCall: ToolCall = {
		type: "toolCall",
		id: call.id,
		name: call.name,
		arguments: call.arguments,
	};
	b.partial.content.push(toolCall);
	const contentIndex = b.partial.content.length - 1;
	stream.push({ type: "toolcall_start", contentIndex, partial: b.partial });
	stream.push({
		type: "toolcall_delta",
		contentIndex,
		delta: JSON.stringify(call.arguments),
		partial: b.partial,
	});
	stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: b.partial });
}

function ensureTextOpen(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.textIdx !== null) return;
	closeThinking(stream, b);
	ensureStarted(stream, b);
	b.partial.content.push({ type: "text", text: "" });
	b.textIdx = b.partial.content.length - 1;
	stream.push({ type: "text_start", contentIndex: b.textIdx, partial: b.partial });
}

function ensureThinkingOpen(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.thinkingIdx !== null) return;
	closeText(stream, b);
	ensureStarted(stream, b);
	b.partial.content.push({ type: "thinking", thinking: "" });
	b.thinkingIdx = b.partial.content.length - 1;
	stream.push({ type: "thinking_start", contentIndex: b.thinkingIdx, partial: b.partial });
}

function closeText(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.textIdx === null) return;
	const idx = b.textIdx;
	b.textIdx = null;
	stream.push({
		type: "text_end",
		contentIndex: idx,
		content: textAt(b.partial, idx).text,
		partial: b.partial,
	});
}

function closeThinking(stream: AssistantMessageEventStream, b: BlockState): void {
	if (b.thinkingIdx === null) return;
	const idx = b.thinkingIdx;
	b.thinkingIdx = null;
	stream.push({
		type: "thinking_end",
		contentIndex: idx,
		content: thinkingAt(b.partial, idx).thinking,
		partial: b.partial,
	});
}

function textAt(p: AssistantMessage, idx: number): { type: "text"; text: string } {
	return p.content[idx] as { type: "text"; text: string };
}

function thinkingAt(p: AssistantMessage, idx: number): { type: "thinking"; thinking: string } {
	return p.content[idx] as { type: "thinking"; thinking: string };
}
