import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test, expect } from "bun:test";
import {
	STEERING_MOD_FILE,
	subagentToolName,
	writeSteeringMod,
} from "../src/mcp/steering.js";

const dirs: string[] = [];
function sandboxDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "picc-steering-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("the generated mod blocks cmd's native agent and names the MCP tool", async () => {
	const dir = sandboxDir();
	const serverName = "pi-cmd-bridge-abc123";
	const file = writeSteeringMod(dir, serverName);

	expect(file).toBe(path.join(dir, STEERING_MOD_FILE));
	expect(existsSync(file)).toBe(true);
	expect(readFileSync(file, "utf8")).toContain(subagentToolName(serverName));

	const mod = await import(pathToFileURL(file).href);
	let hooks: Record<string, (...args: any[]) => any> | undefined;
	mod.default({ hooks: (value: Record<string, (...args: any[]) => any>) => (hooks = value) });

	const blocked = await hooks!.beforeToolCall!({ toolName: "agent", input: {} });
	expect(blocked.block).toBe(true);
	expect(String(blocked.additionalContext)).toContain(subagentToolName(serverName));
	expect(String(blocked.additionalContext)).toContain("Do not retry agent");

	expect(await hooks!.beforeToolCall!({ toolName: "bash", input: { command: "ls" } })).toBeUndefined();
	expect(await hooks!.beforeToolCall!({ toolName: "mcp__pi-cmd-bridge-abc123__subagent_run", input: {} })).toBeUndefined();
});
