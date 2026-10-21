import { test, expect } from "bun:test";
import {
	mcpServerName,
	registerMcpServer,
	unregisterMcpServer,
	removeStaleBridgeServers,
	MCP_NAME_PREFIX,
} from "../src/mcp/register.js";
import { sandbox, setScenario, stubEnv, STUB_BIN, waitForRecord, waitFor, readRecord } from "./helpers.js";

test("mcpServerName generates deterministic prefix-bound names", () => {
	const name1 = mcpServerName("session-123");
	const name2 = mcpServerName("session-123");
	const name3 = mcpServerName("session-456");

	expect(name1.startsWith(MCP_NAME_PREFIX)).toBe(true);
	expect(name1).toBe(name2);
	expect(name1).not.toBe(name3);
	expect(name1.length).toBe(MCP_NAME_PREFIX.length + 8);
});

test("registerMcpServer invokes cmd mcp add-json with local scope", async () => {
	const sb = sandbox();
	setScenario(sb, { exitCode: 0 });

	const name = mcpServerName("test-session");
	const res = await registerMcpServer(
		STUB_BIN,
		stubEnv(sb),
		name,
		{ transport: "stdio", command: "node", args: ["shim.js"] },
		sb.dir,
	);

	expect(res.ok).toBe(true);
	const record = await waitForRecord(sb);
	expect(record.argv).toEqual([
		"mcp",
		"add-json",
		name,
		JSON.stringify({ transport: "stdio", command: "node", args: ["shim.js"] }),
		"-s",
		"local",
	]);
});

test("registerMcpServer reports failure when cmd exits non-zero", async () => {
	const sb = sandbox();
	setScenario(sb, { exitCode: 1, stderr: "invalid json format" });

	const name = mcpServerName("test-fail");
	const res = await registerMcpServer(
		STUB_BIN,
		stubEnv(sb),
		name,
		{ transport: "stdio", command: "node", args: [] },
		sb.dir,
	);

	expect(res.ok).toBe(false);
	expect(res.error).toContain("invalid json format");
});

test("unregisterMcpServer invokes cmd mcp remove with local scope", async () => {
	const sb = sandbox();
	setScenario(sb, { exitCode: 0 });

	const name = mcpServerName("test-rm");
	await unregisterMcpServer(STUB_BIN, stubEnv(sb), name, sb.dir);

	const record = await waitForRecord(sb);
	expect(record.argv).toEqual(["mcp", "remove", name, "-s", "local"]);
});

test("removeStaleBridgeServers cleans up leftover bridge servers", async () => {
	const sb = sandbox();
	// Register a stale bridge server and a user server
	await registerMcpServer(STUB_BIN, stubEnv(sb), "pi-cmd-bridge-stale1", { transport: "stdio", command: "node", args: [] }, sb.dir);
	await registerMcpServer(STUB_BIN, stubEnv(sb), "user-custom-server", { transport: "stdio", command: "node", args: [] }, sb.dir);

	// Run removeStaleBridgeServers
	await removeStaleBridgeServers(STUB_BIN, stubEnv(sb), sb.dir);

	// Check that pi-cmd-bridge-stale1 is removed
	const record = await waitFor(() => {
		const r = readRecord(sb);
		return r?.argv?.[1] === "remove" ? r : null;
	});
	expect(record!.argv).toEqual(["mcp", "remove", "pi-cmd-bridge-stale1", "-s", "local"]);
});

