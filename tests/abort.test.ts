import { test, expect } from "bun:test";
import {
	isAlive,
	runStart,
	runTurn,
	sandbox,
	setScenario,
	stubEnv,
	testModel,
	textDelta,
	userMsg,
	waitFor,
	waitForRecord,
} from "./helpers.js";

const MODEL_ID = "gpt-6-luna";

test("abort terminates the child (SIGTERM) and finishes as aborted (item 8)", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [{ emit: runStart("S9") }, { emit: textDelta("x") }, { hang: true }],
	});
	const controller = new AbortController();
	const turn = runTurn(testModel(MODEL_ID), "S", [userMsg("q")], {
		env: stubEnv(sb),
		sessionId: "abort-1",
		signal: controller.signal,
	});
	// Handled from the start: if the turn fails before the stub spawns, surface
	// that failure instead of racing it against the record file.
	const rec = await Promise.race([turn.then(() => null), waitForRecord(sb).catch(() => null)]);
	if (!rec) throw new Error("turn finished before the stub wrote its record");
	controller.abort();
	const events = await turn;

	const last = events[events.length - 1]!;
	if (last.type !== "error") throw new Error(`expected error terminal, got ${last.type}`);
	expect(last.reason).toBe("aborted");
	expect(last.error.stopReason).toBe("aborted");
	expect(events.filter((e) => e.type === "done").length).toBe(0);

	const dead = await waitFor(() => (isAlive(rec.pid) ? null : true), 3000);
	expect(dead).toBe(true);
});

test("abort escalates to SIGKILL when the child ignores SIGTERM", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [{ emit: runStart("S10") }, { hang: true }],
		ignoreSigterm: true,
	});
	const controller = new AbortController();
	const turn = runTurn(testModel(MODEL_ID), "S", [userMsg("q")], {
		env: stubEnv(sb),
		sessionId: "abort-2",
		signal: controller.signal,
	});
	const rec = await Promise.race([turn.then(() => null), waitForRecord(sb).catch(() => null)]);
	if (!rec) throw new Error("turn finished before the stub wrote its record");
	controller.abort();
	const events = await turn;

	const last = events[events.length - 1]!;
	if (last.type !== "error") throw new Error(`expected error terminal, got ${last.type}`);
	expect(last.reason).toBe("aborted");

	const dead = await waitFor(() => (isAlive(rec.pid) ? null : true), 10_000);
	expect(dead).toBe(true);
}, 20_000);
