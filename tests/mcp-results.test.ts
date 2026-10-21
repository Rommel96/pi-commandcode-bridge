import { test, expect } from "bun:test";
import { matchToolResult } from "../src/mcp/results.js";

const pending = [
	{ id: "picc-1", name: "subagent_run" },
	{ id: "picc-2", name: "subagent_run" },
	{ id: "picc-3", name: "subagent_run" },
];
const results = [
	{ toolCallId: "picc-1", toolName: "subagent_run", text: "one" },
	{ toolCallId: "picc-2", toolName: "subagent_run", text: "two" },
	{ toolCallId: "picc-3", toolName: "subagent_run", text: "three" },
];

test("exact toolCallIds keep three same-name results separate", () => {
	expect(matchToolResult(pending[0]!, pending, results)?.text).toBe("one");
	expect(matchToolResult(pending[1]!, pending, results)?.text).toBe("two");
	expect(matchToolResult(pending[2]!, pending, results)?.text).toBe("three");
});

test("an older same-name result never wins over the exact id", () => {
	const history = [
		{ toolCallId: "picc-old", toolName: "subagent_run", text: "old" },
		{ toolCallId: "picc-2", toolName: "subagent_run", text: "two" },
	];
	expect(matchToolResult(pending[1]!, pending, history)?.text).toBe("two");
});

test("ambiguous same-name calls are not guessed when the id does not match", () => {
	const legacy = [{ toolCallId: "call-subagent_run", toolName: "subagent_run", text: "legacy" }];
	expect(matchToolResult(pending[0]!, pending, legacy)).toBeUndefined();
});

test("a single legacy call still falls back to its name", () => {
	const single = [{ id: "picc-1", name: "subagent_run" }];
	const legacy = [{ toolCallId: "call-subagent_run", toolName: "subagent_run", text: "legacy" }];
	expect(matchToolResult(single[0]!, single, legacy)?.text).toBe("legacy");
});
