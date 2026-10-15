import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { resolveBin } from "./bin.js";
import { specFor, toCmdEffort } from "./models.js";
import { buildDeltaPrompt, buildInitialPrompt, messageText } from "./prompt.js";

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

/** Custom `streamSimple` driving one `cmd -p` run per Pi request (spec R4-R6). */
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

	const finalize = (reason: "stop" | "error" | "aborted", errorMessage?: string): void => {
		if (finished) return;
		finished = true;
		closeText(stream, blocks);
		closeThinking(stream, blocks);
		if (reason === "stop") {
			blocks.partial.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: blocks.partial });
		} else {
			blocks.partial.stopReason = reason;
			blocks.partial.errorMessage = errorMessage ?? "cmd run failed";
			stream.push({ type: "error", reason, error: blocks.partial });
		}
		stream.end();
	};

	const key = conversationKey(context, options);
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
	if (env.CMDCODE_BRIDGE_YOLO === "1") argv.push("--yolo");

	let payload: CmdPayload = { argv, prompt };
	if (options?.onPayload) {
		const replacement = await options.onPayload(payload, model);
		if (replacement !== undefined && replacement !== null) {
			payload = replacement as CmdPayload;
		}
	}

	const signal = options?.signal;
	if (signal?.aborted) {
		finalize("aborted", "Operation aborted");
		return;
	}

	let child;
	try {
		child = spawn(bin, payload.argv, {
			cwd: process.cwd(),
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		finalize("error", `cannot start cmd: ${(error as Error).message}`);
		return;
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
		for (const raw of lines) {
			const line = raw.trim();
			if (!line) continue;
			let parsed: Record<string, any>;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			await options?.onProviderStreamEvent?.(parsed, model);
			if (finished) continue;
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
					appendText(stream, blocks, String(event.delta ?? ""));
					break;
				case "tool_queued":
					appendThinking(
						stream,
						blocks,
						`[cmd tool: ${event.toolName ?? "tool"} ${formatToolDetail(event.input)}]`,
					);
					break;
				case "tool_hook_blocked":
					appendThinking(
						stream,
						blocks,
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
		if (!finished) ensureStarted(stream, blocks);
	});
	child.on("close", (code: number | null) => {
		if (killTimer) clearTimeout(killTimer);
		signal?.removeEventListener("abort", onAbort);
		void (async () => {
			await processing;
			if (finished) return;
			const ok = code === 0 && resultLine !== null && resultLine.subtype === "success";
			if (ok) {
				const sessionId = resultLine.sessionId ?? runSessionId;
				if (sessionId) bindings.set(key, { cmdSessionId: sessionId });
				// F3: a run that emitted only thinking must still surface
				// finalText as text before done.
				const finalText = typeof resultLine.finalText === "string" ? resultLine.finalText : "";
				const hasText = blocks.partial.content.some(
					(b) => b.type === "text" && b.text.length > 0,
				);
				if (!hasText && finalText) {
					appendText(stream, blocks, finalText);
				}
				blocks.partial.usage = toPiUsage(lastRequestUsage ?? resultLine.usage);
				finalize("stop");
				return;
			}
			const exitDesc = code === null ? "killed" : `exit ${code}`;
			let message = resultLine ? `cmd failed (${exitDesc})` : `cmd produced no result (${exitDesc})`;
			const tail = stderrTail.trim();
			if (tail) message += `\n${tail}`;
			finalize("error", message);
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
