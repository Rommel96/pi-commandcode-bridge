import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	Message,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
	Usage,
} from "@earendil-works/pi-ai";
import { streamSimple } from "../src/provider.js";

/** Absolute path of the stub `cmd` executable. */
export const STUB_BIN = path.join(import.meta.dir, "fixtures", "cmd");

export interface StubRecord {
	argv: string[];
	env: Record<string, string>;
	pid: number;
	cwd: string;
	stdin: string;
}

export interface Sandbox {
	dir: string;
	recordFile: string;
	scenarioFile: string;
}

export interface StubStep {
	emit?: unknown;
	raw?: string;
	stderr?: string;
	hang?: boolean;
}

export interface StubScenario {
	script?: StubStep[];
	stderr?: string;
	exitCode?: number;
	ignoreSigterm?: boolean;
}

// Distinct prefix from the broker's run dirs; removed when the test process exits.
const sandboxes: string[] = [];
export function removeSandboxes(): void {
	for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function sandbox(): Sandbox {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-cmd-bridge-test-"));
	sandboxes.push(dir);
	return { dir, recordFile: path.join(dir, "record.json"), scenarioFile: path.join(dir, "scenario.json") };
}

export function setScenario(sb: Sandbox, scenario: StubScenario): void {
	writeFileSync(sb.scenarioFile, JSON.stringify(scenario));
}

/** Env for the child: points at the stub and its record/scenario files. */
export function stubEnv(sb: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
	return {
		// The stub's `#!/usr/bin/env node` shebang needs PATH to find node; without it
		// only systems with node in the default PATH (e.g. /usr/bin on Linux) pass.
		PATH: process.env.PATH ?? "",
		CMDCODE_BRIDGE_BIN: STUB_BIN,
		CMD_STUB_RECORD: sb.recordFile,
		CMD_STUB_SCENARIO: sb.scenarioFile,
		...extra,
	};
}

export function readRecord(sb: Sandbox): StubRecord | null {
	if (!existsSync(sb.recordFile)) return null;
	return JSON.parse(readFileSync(sb.recordFile, "utf8")) as StubRecord;
}

export async function waitForRecord(sb: Sandbox, timeoutMs = 5000): Promise<StubRecord> {
	const rec = await waitFor(() => readRecord(sb), timeoutMs);
	if (!rec) throw new Error("stub never wrote its record file");
	return rec;
}

export async function waitFor<T>(
	probe: () => T | null | undefined,
	timeoutMs = 5000,
	intervalMs = 25,
): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() >= deadline) return null;
		await Bun.sleep(intervalMs);
	}
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A Model<Api> with the provider's custom api id; ids come from the static table. */
export function testModel(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "commandcode-cli" as Api,
		provider: "commandcode",
		baseUrl: "commandcode-cli://commandcode",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	};
}

export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function userMsg(text: string): Message {
	return { role: "user", content: text, timestamp: Date.now() };
}

export function assistantMsg(text: string): Message {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "commandcode-cli" as Api,
		provider: "commandcode",
		model: "gpt-6-luna",
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
	return message;
}

export function toolResultMsg(toolName: string, text: string, toolCallId = `call-${toolName}`): Message {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

export function turnContext(systemPrompt: string, messages: Message[]): TranscriptContext {
	return normalizeContext({ systemPrompt, messages });
}

export async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

export async function runTurn(
	model: Model<Api>,
	systemPrompt: string,
	messages: Message[],
	options?: SimpleStreamOptions,
): Promise<AssistantMessageEvent[]> {
	const stream = streamSimple(model, turnContext(systemPrompt, messages), options);
	return collectEvents(stream);
}

// --- scripted `cmd` NDJSON lines --------------------------------------------

export function runStart(sessionId: string): Record<string, unknown> {
	return { type: "event", event: { type: "run_start", sessionId } };
}

export function textDelta(delta: string): Record<string, unknown> {
	return { type: "event", event: { type: "text_delta", delta } };
}

export function toolQueued(toolName: string, input: unknown): Record<string, unknown> {
	return { type: "event", event: { type: "tool_queued", toolName, input } };
}

export function toolHookBlocked(toolName: string, hookOutput: string): Record<string, unknown> {
	return { type: "event", event: { type: "tool_hook_blocked", toolName, hookOutput } };
}

export function messageEnd(): Record<string, unknown> {
	return { type: "event", event: { type: "message_end" } };
}

export function turnEnd(): Record<string, unknown> {
	return { type: "event", event: { type: "turn_end" } };
}

export function runEnd(): Record<string, unknown> {
	return { type: "event", event: { type: "run_end" } };
}

export interface StubUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

export function resultLine(
	sessionId: string,
	finalText: string,
	usage: StubUsage = { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
): Record<string, unknown> {
	return {
		type: "result",
		subtype: "success",
		sessionId,
		finalText,
		usage,
		durationMs: 12,
	};
}

export function modelRequestEnd(model: string, usage: StubUsage): Record<string, unknown> {
	return { type: "event", event: { type: "model_request_end", model, usage } };
}

/** The value following a flag in argv, e.g. flagValue(argv, "--effort"). */
export function flagValue(argv: string[], flag: string): string | undefined {
	const i = argv.indexOf(flag);
	if (i < 0) return undefined;
	return argv[i + 1];
}
