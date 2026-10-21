import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { startBroker } from "../src/mcp/broker.js";

// ~300 KB of schemas: past Linux's 128 KiB per-string execve limit, which
// applies both to the shim's env and to the `cmd mcp add-json` argument.
const TOOLS = Array.from({ length: 150 }, (_, i) => ({
	name: `tool_${i}`,
	description: "d".repeat(2000),
	parameters: { type: "object", properties: {} },
})) as any;

test("shim receives a large tool set without a huge env or argv element", async () => {
	const broker = startBroker({ tools: TOOLS });
	try {
		const cfg = broker.shimCommand();
		for (const value of [...cfg.args, ...Object.values(cfg.env)]) {
			expect(value.length).toBeLessThan(16 * 1024);
		}
		const shim = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ["pipe", "pipe", "pipe"] });
		let out = "";
		shim.stdout.setEncoding("utf8");
		shim.stdout.on("data", (chunk: string) => (out += chunk));
		shim.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
		const deadline = Date.now() + 5000;
		while (!out.includes("\n") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
		shim.kill();
		const reply = JSON.parse(out.split("\n")[0]!);
		expect(reply.result.tools.length).toBe(150);
	} finally {
		broker.close();
	}
});
