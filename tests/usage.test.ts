import { test, expect } from "bun:test";
import {
	modelRequestEnd,
	resultLine,
	runStart,
	runTurn,
	sandbox,
	setScenario,
	stubEnv,
	testModel,
	textDelta,
	userMsg,
} from "./helpers.js";

const MODEL_ID = "gpt-6-luna";
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

test("usage: fallback to result.usage, input excludes cache reads (item 5, F1)", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit: runStart("S1") },
			{ emit: textDelta("answer") },
			{
				emit: resultLine("S1", "answer", {
					inputTokens: 11,
					outputTokens: 7,
					cacheReadTokens: 5,
					cacheWriteTokens: 3,
				}),
			},
		],
	});
	const events = await runTurn(testModel(MODEL_ID), "S", [userMsg("q")], {
		env: stubEnv(sb),
		sessionId: "usage-1",
	});

	const last = events[events.length - 1]!;
	if (last.type !== "done") throw new Error(`expected done, got ${last.type}`);
	expect(last.reason).toBe("stop");
	expect(last.message.stopReason).toBe("stop");
	expect(last.message.provider).toBe("commandcode");
	expect(last.message.model).toBe(MODEL_ID);
	expect(last.message.usage).toEqual({
		input: 6,
		output: 7,
		cacheRead: 5,
		cacheWrite: 3,
		totalTokens: 21,
		cost: ZERO_COST,
	});
});

test("usage: the LAST model_request_end wins, not the run sum (F1)", async () => {
	const sb = sandbox();
	// Per-request usages whose input sum (600000 + 450000) exceeds the 1M
	// window, and a result.usage run sum far above it (as reported by a real
	// heavy run: 5,039,361 input tokens). Only the last request may be used.
	const first = { inputTokens: 600_000, outputTokens: 100, cacheReadTokens: 500_000, cacheWriteTokens: 0 };
	const lastReq = { inputTokens: 450_000, outputTokens: 200, cacheReadTokens: 400_000, cacheWriteTokens: 10 };
	const runSum = { inputTokens: 5_039_361, outputTokens: 999, cacheReadTokens: 4_000_000, cacheWriteTokens: 0 };
	setScenario(sb, {
		script: [
			{ emit: runStart("S2") },
			{ emit: modelRequestEnd(MODEL_ID, first) },
			{ emit: modelRequestEnd(MODEL_ID, lastReq) },
			{ emit: textDelta("x") },
			{ emit: resultLine("S2", "x", runSum) },
		],
	});
	const events = await runTurn(testModel(MODEL_ID), "S", [userMsg("q")], {
		env: stubEnv(sb),
		sessionId: "usage-2",
	});

	const last = events[events.length - 1]!;
	if (last.type !== "done") throw new Error(`expected done, got ${last.type}`);
	expect(last.message.usage).toEqual({
		input: 50_000,
		output: 200,
		cacheRead: 400_000,
		cacheWrite: 10,
		totalTokens: 450_210,
		cost: ZERO_COST,
	});
	expect(last.message.usage.totalTokens).toBeLessThan(1_000_000);
});

test("usage: input subtraction with real cmd numbers (F1)", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit: runStart("S3") },
			{
				emit: modelRequestEnd("deepseek/deepseek-v4.1-flash", {
					inputTokens: 16_622,
					outputTokens: 6,
					cacheReadTokens: 4_096,
					cacheWriteTokens: 0,
				}),
			},
			{ emit: resultLine("S3", "ok") },
		],
	});
	const events = await runTurn(testModel("deepseek/deepseek-v4.1-flash"), "S", [userMsg("q")], {
		env: stubEnv(sb),
		sessionId: "usage-3",
	});

	const last = events[events.length - 1]!;
	if (last.type !== "done") throw new Error(`expected done, got ${last.type}`);
	expect(last.message.usage).toEqual({
		input: 12_526,
		output: 6,
		cacheRead: 4_096,
		cacheWrite: 0,
		totalTokens: 16_628,
		cost: ZERO_COST,
	});
});
