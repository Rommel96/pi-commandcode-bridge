import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { normalizeContext, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import {
	collectEvents,
	resultLine,
	runStart,
	sandbox,
	setScenario,
	stubEnv,
	testModel,
	textDelta,
	toolResultMsg,
	userMsg,
} from "./helpers.js";
import { streamSimple } from "../src/provider.js";

const MODEL_ID = "gpt-6-luna";

const SUBAGENT_TOOL: Tool = {
	name: "subagent_run",
	description: "Run a subagent to delegate work",
	parameters: {
		type: "object",
		required: ["task"],
		properties: {
			task: { type: "string", description: "The task to delegate" },
		},
	},
};

const BASH_TOOL: Tool = {
	name: "bash",
	description: "Execute a bash command",
	parameters: {
		type: "object",
		required: ["command"],
		properties: {
			command: { type: "string", description: "Shell command" },
		},
	},
};

/** Collect the argv the stub `cmd` received, via its `emit_argv` scenario step. */
function captureArgv(into: string[][]) {
	return async (data: unknown): Promise<void> => {
		const event = (data as { event?: { type?: string; argv?: string[] } })?.event;
		if (event?.type === "stub_argv" && Array.isArray(event.argv)) into.push(event.argv);
	};
}

test("tools present: cmd tool call yields toolCall event and stopReason: 'toolUse'", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit_argv: true },
			{ emit: runStart("S-MCP-1") },
			{ emit: textDelta("Starting delegation...") },
			{
				call_mcp: {
					serverPrefix: "pi-cmd-bridge-",
					tool: "subagent_run",
					args: { task: "inspect architecture" },
				},
			},
			{ emit: textDelta("Finished delegation.") },
			{ emit: resultLine("S-MCP-1", "Done.") },
		],
	});

	const context = normalizeContext({
		systemPrompt: "You are an orchestrator.",
		messages: [userMsg("Please run subagent")],
		tools: [SUBAGENT_TOOL],
	});

	const seenArgv: string[][] = [];
	const stream = streamSimple(testModel(MODEL_ID), context, {
		env: stubEnv(sb),
		sessionId: "mcp-session-1",
		onProviderStreamEvent: captureArgv(seenArgv),
	});

	const events = await collectEvents(stream);

	const argv = seenArgv[0];
	expect(argv).toBeDefined();
	const modPath = argv!.find((arg) => arg.endsWith("pi-delegation-guard.ts"));
	expect(modPath).toBeDefined();
	expect(existsSync(modPath!)).toBe(true);
	const modSource = readFileSync(modPath!, "utf8");
	expect(modSource).toContain("__subagent_run");
	expect(modSource).toContain("Do not retry agent");

	const toolStarts = events.filter((e) => e.type === "toolcall_start");
	const toolEnds = events.filter((e) => e.type === "toolcall_end");
	const dones = events.filter((e) => e.type === "done");

	expect(toolStarts.length).toBe(1);
	expect(toolEnds.length).toBe(1);
	expect(dones.length).toBe(1);

	const done = dones[0]!;
	if (done.type !== "done") throw new Error("expected done event");
	expect(done.reason).toBe("toolUse");
	expect(done.message.stopReason).toBe("toolUse");

	const toolCall = done.message.content.find((b) => b.type === "toolCall");
	expect(toolCall).toBeDefined();
	if (toolCall?.type === "toolCall") {
		expect(toolCall.name).toBe("subagent_run");
		expect(toolCall.arguments).toEqual({ task: "inspect architecture" });
	}

	// Turn 2: Provide toolResult and resume
	const turn2Messages = [
		...context.messages,
		done.message,
		toolResultMsg("subagent_run", "Architecture inspected: all green"),
	];

	const turn2Context = normalizeContext({
		systemPrompt: "You are an orchestrator.",
		messages: turn2Messages,
		tools: [SUBAGENT_TOOL],
	});

	const stream2 = streamSimple(testModel(MODEL_ID), turn2Context, {
		env: stubEnv(sb),
		sessionId: "mcp-session-1",
	});

	const events2 = await collectEvents(stream2);
	const dones2 = events2.filter((e) => e.type === "done");
	expect(dones2.length).toBe(1);
	const done2 = dones2[0]!;
	if (done2.type !== "done") throw new Error("expected done event");
	expect(done2.reason).toBe("stop");
	expect(done2.message.stopReason).toBe("stop");

	const fullText = done2.message.content
		.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("");
	expect(fullText).toContain("Finished delegation.");
});

test("CMDCODE_BRIDGE_NATIVE_AGENT=allow keeps cmd's native agent tool", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit_argv: true },
			{ emit: runStart("S-NATIVE") },
			{ emit: resultLine("S-NATIVE", "ok") },
		],
	});

	const context = normalizeContext({
		systemPrompt: "S",
		messages: [userMsg("q")],
		tools: [SUBAGENT_TOOL],
	});
	const seenArgv: string[][] = [];
	const events = await collectEvents(
		streamSimple(testModel(MODEL_ID), context, {
			env: stubEnv(sb, { CMDCODE_BRIDGE_NATIVE_AGENT: "allow" }),
			sessionId: "native-agent-allow",
			onProviderStreamEvent: captureArgv(seenArgv),
		}),
	);

	expect(events.some((e) => e.type === "done")).toBe(true);
	expect(seenArgv).toHaveLength(1);
	expect(seenArgv[0]!.some((arg) => arg.endsWith("pi-delegation-guard.ts"))).toBe(false);
});

test("runs without subagent_run do not add the guard mod", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit_argv: true },
			{ emit: runStart("S-NO-SUBAGENT") },
			{ emit: resultLine("S-NO-SUBAGENT", "ok") },
		],
	});

	const context = normalizeContext({
		systemPrompt: "S",
		messages: [userMsg("q")],
		tools: [BASH_TOOL],
	});
	const seenArgv: string[][] = [];
	const events = await collectEvents(
		streamSimple(testModel(MODEL_ID), context, {
			env: stubEnv(sb),
			sessionId: "no-subagent",
			onProviderStreamEvent: captureArgv(seenArgv),
		}),
	);

	expect(events.some((e) => e.type === "done")).toBe(true);
	expect(seenArgv).toHaveLength(1);
	expect(seenArgv[0]!.some((arg) => arg.endsWith("pi-delegation-guard.ts"))).toBe(false);
});

test("three parallel same-name calls keep their own results", async () => {
	const sb = sandbox();
	const resultsFile = path.join(sb.dir, "mcp-results.json");
	setScenario(sb, {
		script: [
			{ emit: runStart("S-PARALLEL") },
			{
				call_mcp_many: [
					{ serverPrefix: "pi-cmd-bridge-", tool: "subagent_run", args: { task: "one" } },
					{ serverPrefix: "pi-cmd-bridge-", tool: "subagent_run", args: { task: "two" } },
					{ serverPrefix: "pi-cmd-bridge-", tool: "subagent_run", args: { task: "three" } },
				],
			},
			{ emit: textDelta("ALL-DONE") },
			{ emit: resultLine("S-PARALLEL", "ALL-DONE") },
		],
	});

	const context = normalizeContext({
		systemPrompt: "S",
		messages: [userMsg("q")],
		tools: [SUBAGENT_TOOL],
	});
	const env = stubEnv(sb, { CMD_STUB_MCP_RESULTS: resultsFile });
	const events = await collectEvents(
		streamSimple(testModel(MODEL_ID), context, { env, sessionId: "parallel-session" }),
	);

	const done = events.find((e) => e.type === "done");
	if (!done || done.type !== "done") throw new Error("expected done toolUse event");
	expect(done.reason).toBe("toolUse");
	const calls = done.message.content.filter((b): b is ToolCall => b.type === "toolCall");
	expect(calls).toHaveLength(3);

	const texts = ["RESULT-ONE", "RESULT-TWO", "RESULT-THREE"];
	const turn2Messages = [
		...context.messages,
		done.message,
		...calls.map((call, index) => toolResultMsg("subagent_run", texts[index]!, call.id)),
	];
	const events2 = await collectEvents(
		streamSimple(
			testModel(MODEL_ID),
			normalizeContext({ systemPrompt: "S", messages: turn2Messages, tools: [SUBAGENT_TOOL] }),
			{ env, sessionId: "parallel-session" },
		),
	);
	const done2 = events2.find((e) => e.type === "done");
	expect(done2?.type === "done" && done2.reason).toBe("stop");

	const results = JSON.parse(readFileSync(resultsFile, "utf8")) as Array<{
		content: Array<{ text: string }>;
	}>;
	expect(results).toHaveLength(3);
	const received = results.map((result) => result.content.map((block) => block.text).join(""));
	expect(received.sort()).toEqual([...texts].sort());
});

test("empty tools array runs direct without MCP registration", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit: runStart("S-DIRECT") },
			{ emit: textDelta("Direct answer") },
			{ emit: resultLine("S-DIRECT", "Direct answer") },
		],
	});

	const context = normalizeContext({
		systemPrompt: "Direct prompt.",
		messages: [userMsg("hello")],
		tools: [],
	});

	const stream = streamSimple(testModel(MODEL_ID), context, {
		env: stubEnv(sb),
		sessionId: "direct-session",
	});

	const events = await collectEvents(stream);
	const dones = events.filter((e) => e.type === "done");
	expect(dones.length).toBe(1);
	expect(dones[0]!.type === "done" && dones[0]!.reason).toBe("stop");
	expect(events.some((e) => e.type === "toolcall_start")).toBe(false);
});

test("aborting during turn 2 terminates child and reports aborted", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit: runStart("S-MCP-ABORT") },
			{
				call_mcp: {
					serverPrefix: "pi-cmd-bridge-",
					tool: "subagent_run",
					args: { task: "long task" },
				},
			},
			{ hang: true },
		],
	});

	const context = normalizeContext({
		systemPrompt: "You are an orchestrator.",
		messages: [userMsg("run")],
		tools: [SUBAGENT_TOOL],
	});

	const stream = streamSimple(testModel(MODEL_ID), context, {
		env: stubEnv(sb),
		sessionId: "abort-session",
	});

	const events = await collectEvents(stream);
	const done = events.find((e) => e.type === "done");
	expect(done?.type === "done" && done.reason).toBe("toolUse");

	// Turn 2 with abort controller
	const controller = new AbortController();
	const turn2Messages = [
		...context.messages,
		(done as any).message,
		toolResultMsg("subagent_run", "result"),
	];

	const stream2 = streamSimple(
		testModel(MODEL_ID),
		normalizeContext({ systemPrompt: "S", messages: turn2Messages, tools: [SUBAGENT_TOOL] }),
		{
			env: stubEnv(sb),
			sessionId: "abort-session",
			signal: controller.signal,
		},
	);

	// Abort shortly after resume
	setTimeout(() => controller.abort(), 40);

	const events2 = await collectEvents(stream2);
	const errors = events2.filter((e) => e.type === "error");
	expect(errors.length).toBe(1);
	expect(errors[0]!.type === "error" && errors[0]!.reason).toBe("aborted");
});

test("superseded turn: new user message without toolResult restarts cleanly", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit: runStart("S-MCP-SUPERSEDE") },
			{
				call_mcp: {
					serverPrefix: "pi-cmd-bridge-",
					tool: "subagent_run",
					args: { task: "initial" },
				},
			},
			{ emit: textDelta("Should not reach here") },
			{ emit: resultLine("S-MCP-SUPERSEDE", "Never") },
		],
	});

	const context = normalizeContext({
		systemPrompt: "Orchestrator",
		messages: [userMsg("first task")],
		tools: [SUBAGENT_TOOL],
	});

	const stream = streamSimple(testModel(MODEL_ID), context, {
		env: stubEnv(sb),
		sessionId: "supersede-session",
	});

	const events = await collectEvents(stream);
	expect(events.some((e) => e.type === "done" && e.reason === "toolUse")).toBe(true);

	// Instead of toolResult, user sends a completely new question
	setScenario(sb, {
		script: [
			{ emit: runStart("S-MCP-FRESH") },
			{ emit: textDelta("Fresh response") },
			{ emit: resultLine("S-MCP-FRESH", "Fresh response") },
		],
	});

	const freshContext = normalizeContext({
		systemPrompt: "Orchestrator",
		messages: [userMsg("Never mind, do this instead")],
		tools: [SUBAGENT_TOOL],
	});

	const stream2 = streamSimple(testModel(MODEL_ID), freshContext, {
		env: stubEnv(sb),
		sessionId: "supersede-session",
	});

	const events2 = await collectEvents(stream2);
	const done2 = events2.find((e) => e.type === "done");
	expect(done2?.type === "done" && done2.reason).toBe("stop");
	const text = done2?.type === "done"
		? done2.message.content.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text").map((b) => b.text).join("")
		: "";
	expect(text).toContain("Fresh response");
});
