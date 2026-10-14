import { test, expect } from "bun:test";
import {
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

test("usage mapping and zero cost (item 5)", async () => {
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
		input: 11,
		output: 7,
		cacheRead: 5,
		cacheWrite: 3,
		totalTokens: 26,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
});
