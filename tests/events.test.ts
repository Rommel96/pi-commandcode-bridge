import { test, expect } from "bun:test";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import {
	messageEnd,
	resultLine,
	runEnd,
	runStart,
	runTurn,
	sandbox,
	setScenario,
	stubEnv,
	testModel,
	textDelta,
	toolHookBlocked,
	toolQueued,
	turnEnd,
	userMsg,
} from "./helpers.js";

const MODEL_ID = "gpt-6-luna";

function count(events: AssistantMessageEvent[], type: AssistantMessageEvent["type"]): number {
	return events.filter((e) => e.type === type).length;
}

test("event order: one start, balanced text events, exactly one done (item 4)", async () => {
	const sb = sandbox();
	const lines = [
		runStart("S1"),
		textDelta("Hel"),
		textDelta("lo"),
		messageEnd(),
		turnEnd(),
		runEnd(),
		resultLine("S1", "Hello"),
	];
	setScenario(sb, { script: lines.map((emit) => ({ emit })) });
	const providerEvents: unknown[] = [];
	const events = await runTurn(testModel(MODEL_ID), "S", [userMsg("q")], {
		env: stubEnv(sb),
		sessionId: "ev-1",
		onProviderStreamEvent: async (data) => {
			providerEvents.push(data);
		},
	});

	expect(events[0]!.type).toBe("start");
	expect(count(events, "start")).toBe(1);
	expect(count(events, "done")).toBe(1);
	expect(count(events, "error")).toBe(0);
	expect(events[events.length - 1]!.type).toBe("done");

	expect(count(events, "text_start")).toBe(count(events, "text_end"));
	expect(count(events, "thinking_start")).toBe(count(events, "thinking_end"));

	const deltas = events
		.filter((e): e is Extract<AssistantMessageEvent, { type: "text_delta" }> => e.type === "text_delta")
		.map((e) => e.delta)
		.join("");
	expect(deltas).toBe("Hello");

	// every text_start is closed by a text_end at the same contentIndex
	const open = new Set<number>();
	for (const e of events) {
		if (e.type === "text_start") open.add(e.contentIndex);
		if (e.type === "text_end") {
			expect(open.has(e.contentIndex)).toBe(true);
			open.delete(e.contentIndex);
		}
	}
	expect(open.size).toBe(0);

	// options.onProviderStreamEvent is awaited for each parsed NDJSON line
	expect(providerEvents.length).toBe(lines.length);
	expect(providerEvents[0]).toEqual(runStart("S1"));
	expect(providerEvents[providerEvents.length - 1]).toEqual(resultLine("S1", "Hello"));
});

test("tool events become thinking content and never Pi tool calls (item 6)", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit: runStart("S2") },
			{ emit: toolQueued("write_file", { path: "/path" }) },
			{ emit: toolHookBlocked("write_file", "nope") },
			{ emit: textDelta("done") },
			{ emit: resultLine("S2", "done") },
		],
	});
	const events = await runTurn(testModel(MODEL_ID), "S", [userMsg("q")], {
		env: stubEnv(sb),
		sessionId: "ev-2",
	});

	expect(count(events, "toolcall_start")).toBe(0);
	expect(count(events, "toolcall_delta")).toBe(0);
	expect(count(events, "toolcall_end")).toBe(0);
	expect(count(events, "thinking_start")).toBe(count(events, "thinking_end"));
	expect(count(events, "thinking_start")).toBeGreaterThan(0);

	const last = events[events.length - 1]!;
	if (last.type !== "done") throw new Error(`expected done, got ${last.type}`);
	const content = last.message.content;
	expect(content.some((b) => b.type === "toolCall")).toBe(false);
	const thinking = content
		.filter((b): b is Extract<typeof b, { type: "thinking" }> => b.type === "thinking")
		.map((b) => b.thinking)
		.join("\n");
	expect(thinking).toContain("[cmd tool: write_file /path]");
	expect(thinking).toContain("[cmd blocked: write_file: nope]");
});

test("Unicode deltas split across chunks are preserved (item 10)", async () => {
	const text = "héllo ✓ ok";
	const line = Buffer.from(JSON.stringify(textDelta(text)) + "\n", "utf8");
	const eStart = line.indexOf(Buffer.from("é", "utf8"));
	const cStart = line.indexOf(Buffer.from("✓", "utf8"));
	expect(eStart).toBeGreaterThan(0);
	expect(cStart).toBeGreaterThan(eStart);
	const chunks = [
		line.subarray(0, eStart + 1),
		line.subarray(eStart + 1, cStart + 2),
		line.subarray(cStart + 2),
	];

	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit: runStart("S3") },
			...chunks.map((c) => ({ raw: c.toString("base64") })),
			{ emit: resultLine("S3", text) },
		],
	});
	const events = await runTurn(testModel(MODEL_ID), "S", [userMsg("q")], {
		env: stubEnv(sb),
		sessionId: "ev-3",
	});

	const deltas = events
		.filter((e): e is Extract<AssistantMessageEvent, { type: "text_delta" }> => e.type === "text_delta")
		.map((e) => e.delta)
		.join("");
	expect(deltas).toBe(text);

	const last = events[events.length - 1]!;
	if (last.type !== "done") throw new Error(`expected done, got ${last.type}`);
	const fullText = last.message.content
		.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
		.map((b) => b.text)
		.join("");
	expect(fullText).toBe(text);
});
