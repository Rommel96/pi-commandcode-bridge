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

const MODEL_ID = "xiaomi/mimo-v2.6-pro";

test("non-zero exit becomes one error with the stderr tail (item 7)", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit: runStart("S1") },
			{ emit: textDelta("partial") },
			{ stderr: "some context\nMiMo V2.6 Pro has no adjustable reasoning effort.\n" },
		],
		exitCode: 1,
	});
	const events = await runTurn(testModel(MODEL_ID), "S", [userMsg("q")], {
		env: stubEnv(sb),
		sessionId: "err-1",
		reasoning: "max",
	});

	expect(events.filter((e) => e.type === "error").length).toBe(1);
	expect(events.filter((e) => e.type === "done").length).toBe(0);
	const last = events[events.length - 1]!;
	if (last.type !== "error") throw new Error(`expected error, got ${last.type}`);
	expect(last.reason).toBe("error");
	expect(last.error.stopReason).toBe("error");
	expect(last.error.errorMessage ?? "").toContain("MiMo V2.6 Pro has no adjustable reasoning effort.");
});

test("missing result line becomes one error, even with exit 0", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [{ emit: runStart("S2") }, { emit: textDelta("partial") }],
		exitCode: 0,
	});
	const events = await runTurn(testModel(MODEL_ID), "S", [userMsg("q")], {
		env: stubEnv(sb),
		sessionId: "err-2",
	});

	expect(events.filter((e) => e.type === "error").length).toBe(1);
	expect(events.filter((e) => e.type === "done").length).toBe(0);
	const last = events[events.length - 1]!;
	if (last.type !== "error") throw new Error(`expected error, got ${last.type}`);
	expect(last.reason).toBe("error");
	expect((last.error.errorMessage ?? "").length).toBeGreaterThan(0);
});

test("result line with a failed subtype becomes one error", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [
			{ emit: runStart("S3") },
			{ emit: { type: "result", subtype: "error", sessionId: "S3", finalText: "" } },
			{ stderr: "boom\n" },
		],
		exitCode: 1,
	});
	const events = await runTurn(testModel(MODEL_ID), "S", [userMsg("q")], {
		env: stubEnv(sb),
		sessionId: "err-3",
	});

	expect(events.filter((e) => e.type === "error").length).toBe(1);
	expect(events.filter((e) => e.type === "done").length).toBe(0);
	const last = events[events.length - 1]!;
	if (last.type !== "error") throw new Error(`expected error, got ${last.type}`);
	expect(last.error.errorMessage ?? "").toContain("boom");
});
