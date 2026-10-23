/**
 * Broker start-failure and child-nonce contract at the provider seam.
 *
 * A broker that cannot listen must not take Pi down with it: the run continues
 * without bridged tools, says why once as thinking text, and spawns `cmd`
 * exactly as a run without Pi tools would. The per-run child nonce travels
 * only in that child's environment.
 */
import { test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { normalizeContext, type Tool } from "@earendil-works/pi-ai";
import {
	collectEvents,
	readRecord,
	resultLine,
	runStart,
	sandbox,
	setScenario,
	stubEnv,
	testModel,
	textDelta,
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
		properties: { task: { type: "string", description: "The task to delegate" } },
	},
};

/** Collect the argv the stub `cmd` received, via its `emit_argv` scenario step. */
function captureArgv(into: string[][]) {
	return async (data: unknown): Promise<void> => {
		const event = (data as { event?: { type?: string; argv?: string[] } })?.event;
		if (event?.type === "stub_argv" && Array.isArray(event.argv)) into.push(event.argv);
	};
}

function thinkingOf(message: { content: Array<Record<string, any>> }): string {
	return message.content
		.filter((block) => block.type === "thinking")
		.map((block) => String(block.thinking ?? ""))
		.join("");
}

test("broker start failure keeps the turn alive without MCP registration or steering", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit_argv: true },
			{ emit: runStart("S-FALLBACK") },
			{ emit: textDelta("Fallback answer") },
			{ emit: resultLine("S-FALLBACK", "Fallback answer") },
		],
	});

	const context = normalizeContext({
		systemPrompt: "You are an orchestrator.",
		messages: [userMsg("delegate")],
		tools: [SUBAGENT_TOOL],
	});
	const seenArgv: string[][] = [];
	const env = stubEnv(sb, {
		// A socket inside a non-existent directory: listen fails with ENOENT.
		CMDCODE_BRIDGE_BROKER_ENDPOINT: path.join(sb.dir, "no-such-directory", "broker.sock"),
	});

	const events = await collectEvents(
		streamSimple(testModel(MODEL_ID), context, {
			env,
			sessionId: "broker-fallback-session",
			onProviderStreamEvent: captureArgv(seenArgv),
		}),
	);

	expect(events.some((event) => event.type === "error")).toBe(false);
	const done = events.find((event) => event.type === "done");
	expect(done?.type === "done" && done.reason).toBe("stop");
	if (!done || done.type !== "done") throw new Error("expected a normal done event");

	const thinking = thinkingOf(done.message);
	expect(thinking).toContain("[bridge: Pi tools unavailable this run:");
	// The reason is surfaced verbatim (the runtime names the endpoint it could not bind).
	expect(thinking).toContain(path.join("no-such-directory", "broker.sock"));
	expect(done.message.content.some((block) => block.type === "text" && block.text.includes("Fallback answer"))).toBe(true);

	expect(seenArgv).toHaveLength(1);
	// The attribution mod is always there; the delegation guard is not.
	expect(seenArgv[0]!.some((arg) => arg.endsWith("pi-delegation-guard.ts"))).toBe(false);
	expect(existsSync(path.join(sb.dir, "mcp-servers"))).toBe(false);
	expect(readRecord(sb)!.env.PICC_BRIDGE_CHILD).toBeUndefined();
});

test("the child nonce reaches the spawned cmd env but never the MCP registration", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit: runStart("S-NONCE") },
			{ call_mcp: { serverPrefix: "pi-cmd-bridge-", tool: "subagent_run", args: { task: "x" } } },
			{ emit: textDelta("after delegation") },
			{ emit: resultLine("S-NONCE", "ok") },
		],
	});

	const context = normalizeContext({
		systemPrompt: "S",
		messages: [userMsg("q")],
		tools: [SUBAGENT_TOOL],
	});

	// Turn 1 parks on the bridged call, so the registration is still on disk.
	const events = await collectEvents(
		streamSimple(testModel(MODEL_ID), context, { env: stubEnv(sb), sessionId: "nonce-session" }),
	);
	const done = events.find((event) => event.type === "done");
	expect(done?.type === "done" && done.reason).toBe("toolUse");
	if (!done || done.type !== "done") throw new Error("expected a toolUse done event");

	const record = readRecord(sb)!;
	expect(typeof record.env.PICC_BRIDGE_CHILD).toBe("string");
	expect(record.env.PICC_BRIDGE_CHILD!.length).toBeGreaterThanOrEqual(16);

	const mcpDir = path.join(sb.dir, "mcp-servers");
	const files = readdirSync(mcpDir).filter((file) => file.endsWith(".json"));
	expect(files).toHaveLength(1);
	const config = JSON.parse(readFileSync(path.join(mcpDir, files[0]!), "utf8"));
	expect(config.env.PICC_BRIDGE_CHILD).toBeUndefined();
	expect(typeof config.env.PICC_SHIM_TOKEN).toBe("string");

	// Turn 2 settles the parked call and tears the session down.
	const call = done.message.content.find((block) => block.type === "toolCall");
	if (!call || call.type !== "toolCall") throw new Error("expected the parked toolCall");
	const turn2 = [
		...context.messages,
		done.message,
		{
			role: "toolResult" as const,
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text" as const, text: "done" }],
			isError: false,
			timestamp: Date.now(),
		},
	];
	const events2 = await collectEvents(
		streamSimple(
			testModel(MODEL_ID),
			normalizeContext({ systemPrompt: "S", messages: turn2, tools: [SUBAGENT_TOOL] }),
			{ env: stubEnv(sb), sessionId: "nonce-session" },
		),
	);
	expect(events2.some((event) => event.type === "done" && event.reason === "stop")).toBe(true);
});
