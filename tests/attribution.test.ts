import { existsSync } from "node:fs";
import { test, expect } from "bun:test";
import { attributionArgs, attributionModPath } from "../src/attribution.js";
import stripCommitAttribution from "../src/mods/strip-commit-attribution.js";
import { flagValue, resultLine, runStart, runTurn, sandbox, setScenario, stubEnv, testModel, userMsg, waitForRecord } from "./helpers.js";

const TRAILER = "Co-authored-by: CommandCodeBot <noreply@commandcode.ai>";

type Hooks = { beforeToolCall: (event: { input: unknown }) => { input: unknown } | undefined };

function loadHooks(): Hooks {
	let captured: Hooks | undefined;
	stripCommitAttribution({
		hooks(h: Hooks) {
			captured = h;
		},
	} as never);
	expect(captured).toBeDefined();
	return captured!;
}

test("mod strips the CommandCodeBot trailer from a nested tool input", () => {
	const { beforeToolCall } = loadHooks();
	const result = beforeToolCall({
		input: {
			command: `git commit -F - <<'EOF'\nAdd a\n\n${TRAILER}\nEOF`,
			meta: [{ note: "keep" }],
		},
	});
	expect(result).toEqual({
		input: { command: "git commit -F - <<'EOF'\nAdd a\n\nEOF", meta: [{ note: "keep" }] },
	});
});

test("mod returns undefined when the input has no trailer", () => {
	const { beforeToolCall } = loadHooks();
	expect(beforeToolCall({ input: { command: "ls -la", n: 1, flag: true, none: null } })).toBeUndefined();
});

test("mod keeps other Co-authored-by trailers", () => {
	const { beforeToolCall } = loadHooks();
	const input = { command: "git commit -m 'x\n\nCo-authored-by: Jane <jane@x.io>'" };
	expect(beforeToolCall({ input })).toBeUndefined();
});

test("attributionArgs adds the mod unless CMDCODE_BRIDGE_COMMIT_ATTRIBUTION=keep", () => {
	expect(attributionArgs({})).toEqual(["--mod", attributionModPath()]);
	expect(attributionArgs({ CMDCODE_BRIDGE_COMMIT_ATTRIBUTION: "keep" })).toEqual([]);
	expect(existsSync(attributionModPath())).toBe(true);
	expect(attributionModPath().endsWith("strip-commit-attribution.ts")).toBe(true);
});

test("argv carries the attribution mod by default and omits it with keep", async () => {
	const script = (id: string) => ({ script: [{ emit: runStart(id) }, { emit: resultLine(id, "ok") }] });
	const model = testModel("deepseek/deepseek-v4.1-flash");

	const sb = sandbox();
	setScenario(sb, script("A1"));
	await runTurn(model, "S", [userMsg("q")], { env: stubEnv(sb), sessionId: "attr-1" });
	const rec = await waitForRecord(sb);
	expect(flagValue(rec.argv, "--mod")).toBe(attributionModPath());

	const sb2 = sandbox();
	setScenario(sb2, script("A2"));
	await runTurn(model, "S", [userMsg("q")], {
		env: stubEnv(sb2, { CMDCODE_BRIDGE_COMMIT_ATTRIBUTION: "keep" }),
		sessionId: "attr-2",
	});
	const rec2 = await waitForRecord(sb2);
	expect(rec2.argv).not.toContain("--mod");
});
