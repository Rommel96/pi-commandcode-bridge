import { test, expect } from "bun:test";
import {
	assistantMsg,
	flagValue,
	resultLine,
	runStart,
	runTurn,
	sandbox,
	setScenario,
	stubEnv,
	testModel,
	toolResultMsg,
	userMsg,
	waitForRecord,
} from "./helpers.js";

const MODEL_ID = "gpt-6-luna";

test("first request sends the system prompt, the prior transcript and the latest user message, with no --resume", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [{ emit: runStart("cmd-1") }, { emit: resultLine("cmd-1", "answer") }],
	});
	await runTurn(
		testModel(MODEL_ID),
		"SYSTEM PROMPT TEXT",
		[userMsg("turn zero question"), assistantMsg("turn zero answer"), userMsg("latest question")],
		{ env: stubEnv(sb), sessionId: "conv-a" },
	);
	const rec = await waitForRecord(sb);
	expect(rec.argv).not.toContain("--resume");
	const prompt = rec.stdin;
	expect(prompt).toContain("SYSTEM PROMPT TEXT");
	expect(prompt).toContain("turn zero question");
	expect(prompt).toContain("turn zero answer");
	expect(prompt).toContain("latest question");
});

test("second request in the same conversation passes --resume <sid> and only the new messages (item 3)", async () => {
	const sb = sandbox();
	setScenario(sb, {
		script: [{ emit: runStart("cmd-42") }, { emit: resultLine("cmd-42", "first answer") }],
	});
	await runTurn(testModel(MODEL_ID), "SYSTEM PROMPT TEXT", [userMsg("first question")], {
		env: stubEnv(sb),
		sessionId: "conv-b",
	});

	setScenario(sb, {
		script: [{ emit: runStart("cmd-42") }, { emit: resultLine("cmd-42", "second answer") }],
	});
	await runTurn(
		testModel(MODEL_ID),
		"SYSTEM PROMPT TEXT",
		[
			userMsg("first question"),
			assistantMsg("first answer"),
			toolResultMsg("read_file", "TOOL RESULT TEXT"),
			userMsg("second question"),
		],
		{ env: stubEnv(sb), sessionId: "conv-b" },
	);
	const rec = await waitForRecord(sb);
	expect(rec.argv).toContain("--resume");
	expect(flagValue(rec.argv, "--resume")).toBe("cmd-42");
	const prompt = rec.stdin;
	expect(prompt).toContain("second question");
	expect(prompt).toContain("TOOL RESULT TEXT");
	expect(prompt).not.toContain("first question");
	expect(prompt).not.toContain("first answer");
	expect(prompt).not.toContain("SYSTEM PROMPT TEXT");
});
