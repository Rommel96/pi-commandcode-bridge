import { test, expect } from "bun:test";
import {
	flagValue,
	readRecord,
	resultLine,
	runStart,
	runTurn,
	sandbox,
	setScenario,
	stubEnv,
	testModel,
	userMsg,
	waitForRecord,
} from "./helpers.js";

const MODEL_ID = "deepseek/deepseek-v4.1-flash";

function okScenario(sessionId: string) {
	return {
		script: [{ emit: runStart(sessionId) }, { emit: resultLine(sessionId, "ok") }],
	};
}

test("argv: -p prompt, --output-format json, --skip-onboarding, --trust, -m <id>, no --yolo by default", async () => {
	const sb = sandbox();
	setScenario(sb, okScenario("S1"));
	await runTurn(testModel(MODEL_ID), "SYSTEM PROMPT TEXT", [userMsg("hello world")], {
		env: stubEnv(sb),
		sessionId: "argv-1",
	});
	const rec = await waitForRecord(sb);
	expect(rec.argv).toContain("-p");
	expect(rec.argv).toContain("--output-format");
	expect(flagValue(rec.argv, "--output-format")).toBe("json");
	expect(rec.argv).toContain("--skip-onboarding");
	expect(rec.argv).toContain("--trust");
	expect(rec.argv).toContain("-m");
	expect(flagValue(rec.argv, "-m")).toBe(MODEL_ID);
	expect(rec.argv).not.toContain("--yolo");
	expect(rec.argv).not.toContain("--resume");
	const prompt = flagValue(rec.argv, "-p") ?? "";
	expect(prompt).toContain("hello world");
	expect(prompt).toContain("SYSTEM PROMPT TEXT");
});

test("argv: --yolo only when CMDCODE_BRIDGE_YOLO=1", async () => {
	const sb = sandbox();
	setScenario(sb, okScenario("S2"));
	await runTurn(testModel(MODEL_ID), "S", [userMsg("q")], {
		env: stubEnv(sb, { CMDCODE_BRIDGE_YOLO: "1" }),
		sessionId: "argv-2",
	});
	expect(readRecord(sb)!.argv).toContain("--yolo");

	const sb2 = sandbox();
	setScenario(sb2, okScenario("S3"));
	await runTurn(testModel(MODEL_ID), "S", [userMsg("q")], {
		env: stubEnv(sb2, { CMDCODE_BRIDGE_YOLO: "0" }),
		sessionId: "argv-3",
	});
	expect(readRecord(sb2)!.argv).not.toContain("--yolo");
});

test("child env has CMD_HERDR=0 and inherits the environment (item 9)", async () => {
	const sb = sandbox();
	setScenario(sb, okScenario("S4"));
	process.env.CMDBRIDGE_TEST_INHERIT = "inherited-value";
	try {
		await runTurn(testModel(MODEL_ID), "S", [userMsg("q")], {
			env: stubEnv(sb),
			sessionId: "argv-4",
		});
	} finally {
		delete process.env.CMDBRIDGE_TEST_INHERIT;
	}
	const rec = await waitForRecord(sb);
	expect(rec.env.CMD_HERDR).toBe("0");
	expect(rec.env.CMDBRIDGE_TEST_INHERIT).toBe("inherited-value");
});

test("onPayload receives the argv and prompt; a replacement payload is used", async () => {
	const sb = sandbox();
	setScenario(sb, okScenario("S5"));
	let seen: { argv: string[]; prompt: string } | undefined;
	await runTurn(testModel(MODEL_ID), "S", [userMsg("payload question")], {
		env: stubEnv(sb),
		sessionId: "argv-5",
		onPayload: (payload) => {
			seen = payload as { argv: string[]; prompt: string };
			const i = seen.argv.indexOf("-p");
			return {
				argv: [...seen.argv.slice(0, i + 1), "REPLACED PROMPT", ...seen.argv.slice(i + 2)],
				prompt: "REPLACED PROMPT",
			};
		},
	});
	expect(seen).toBeDefined();
	expect(seen!.prompt).toContain("payload question");
	expect(seen!.argv).toContain("-p");
	expect(seen!.argv).toContain("--trust");
	const rec = await waitForRecord(sb);
	expect(flagValue(rec.argv, "-p")).toBe("REPLACED PROMPT");
});
