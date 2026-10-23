import { test, expect } from "bun:test";
import { resultLine, runStart, runTurn, sandbox, setScenario, stubEnv, testModel, userMsg, waitForRecord } from "./helpers.js";

// Pi already sends its own skills in the system prompt it hands to cmd, so cmd's
// skill catalog is repeated context (~6.3K input tokens per request).
test("argv skips cmd's skill discovery by default and keeps it with CMDCODE_BRIDGE_CMD_SKILLS=1", async () => {
	const script = (id: string) => ({ script: [{ emit: runStart(id) }, { emit: resultLine(id, "ok") }] });
	const model = testModel("deepseek/deepseek-v4.1-flash");

	const sb = sandbox();
	setScenario(sb, script("K1"));
	await runTurn(model, "S", [userMsg("q")], { env: stubEnv(sb), sessionId: "skills-1" });
	expect((await waitForRecord(sb)).argv).toContain("--no-skills");

	const sb2 = sandbox();
	setScenario(sb2, script("K2"));
	await runTurn(model, "S", [userMsg("q")], {
		env: stubEnv(sb2, { CMDCODE_BRIDGE_CMD_SKILLS: "1" }),
		sessionId: "skills-2",
	});
	expect((await waitForRecord(sb2)).argv).not.toContain("--no-skills");
});
