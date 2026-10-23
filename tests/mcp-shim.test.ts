/**
 * Round-trip tests for the stdio MCP shim and its IPC transport (issue #1).
 *
 * The shim is spawned BY `cmd` (registered as an MCP server) and speaks MCP
 * JSON-RPC over stdio to the child. Tool calls are parked (no answer) and
 * forwarded over a unix socket to the broker in the Pi host process, which
 * resolves them when Pi returns the tool result on a later turn.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, expect } from "bun:test";
import { startIpcServer, type IpcServer } from "../src/mcp/ipc.js";

const SHIM_PATH = path.join(import.meta.dir, "..", "src", "mcp", "shim.js");

const TOOLS = [
	{
		name: "subagent_run",
		description: "Delegate work",
		inputSchema: { type: "object", required: ["agent", "task"], properties: { agent: { type: "string" }, task: { type: "string" } } },
	},
];

class ShimProc {
	proc: ReturnType<typeof spawn>;
	baseId = 1;
	private waiters: Array<(line: string) => void> = [];
	private buffer = "";

	constructor(socketPath: string, extraEnv: Record<string, string> = {}) {
		this.proc = spawn(process.execPath, [SHIM_PATH], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PICC_SHIM_SOCKET: socketPath, PICC_SHIM_TOOLS: toolsB64(TOOLS), ...extraEnv },
		});
		this.proc.stdout!.setEncoding("utf8");
		this.proc.stdout!.on("data", (chunk: string) => {
			this.buffer += chunk;
			let nl = this.buffer.indexOf("\n");
			while (nl >= 0) {
				const line = this.buffer.slice(0, nl).trim();
				this.buffer = this.buffer.slice(nl + 1);
				if (line) {
					for (const w of this.waiters.splice(0)) w(line);
				}
				nl = this.buffer.indexOf("\n");
			}
		});
		this.proc.stderr!.setEncoding("utf8");
		this.proc.stderr!.on("data", (c: string) => {
		});
	}

	nextId(): number {
		return this.baseId++;
	}

	request(id: number, method: string, params?: unknown): void {
		this.proc.stdin!.write(
			JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n",
		);
	}

	/** Read the next response line, or null after `ms`. */
	line(msTimeout = 5000): Promise<string | null> {
		return new Promise((resolve) => {
			let done = false;
			const timer = setTimeout(() => {
				if (!done) {
					done = true;
					resolve(null);
				}
			}, msTimeout);
			this.waiters.push((line) => {
				if (!done) {
					done = true;
					clearTimeout(timer);
					resolve(line);
				}
			});
		});
	}

	/** Send one JSON-RPC request and read its reply. */
	async rpc(method: string, params?: unknown, msTimeout = 5000): Promise<Record<string, any>> {
		const id = this.nextId();
		this.request(id, method, params);
		const line = await this.line(msTimeout);
		if (!line) throw new Error(`shim did not answer ${method}`);
		return JSON.parse(line);
	}

	/** Inject raw stdin lines (malformed input tests). */
	stdin(...lines: string[]): void {
		this.proc.stdin!.write(lines.join("\n") + "\n");
	}

	kill(): void {
		try {
			this.proc.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}

	/** Assert a well-formed JSON-RPC success reply and return its `result`. */
	static ok(reply: Record<string, any>): Record<string, any> {
		expect(reply.jsonrpc).toBe("2.0");
		expect(reply.error).toBeUndefined();
		return reply.result;
	}
}

function toolsB64(tools: unknown): string {
	return Buffer.from(JSON.stringify(tools), "utf8").toString("base64");
}

/**
 * A trivial broker for tests: records forwarded calls and exposes explicit
 * `respond` hooks so tests decide when (and with what) each parked call returns.
 */
function fakeBroker(dir: string) {
	const socketPath = path.join(dir, "router.sock");
	const calls: any[] = [];
	const hooks: Array<(result: { content: unknown; isError?: boolean }) => void> = [];
	const server: IpcServer = startIpcServer(socketPath, (call) => {
		expect(call.kind).toBe("call");
		expect(typeof call.id).toBe("string");
		expect(typeof call.name).toBe("string");
		calls.push(call);
		return new Promise((resolve) => {
			hooks.push((result) => resolve({ content: result.content as any, isError: result.isError }));
		});
	});
	/** Resolve the n-th parked call. */
	function respond(index: number, result: { content: unknown; isError?: boolean }): void {
		const hook = hooks[index];
		if (!hook) throw new Error(`no parked call at ${index}`);
		hook(result);
	}
	return { socketPath, calls, server, respond };
}

const tmpdirs: string[] = [];
function sandboxDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "picc-shim-"));
	tmpdirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tmpdirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("shim answers initialize, tools/list and ping from argv without asking the broker", async () => {
	const broker = fakeBroker(sandboxDir());
	const shim = new ShimProc(broker.socketPath);
	try {
		const init = ShimProc.ok(await shim.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} }));
		expect(init.capabilities.tools).toBeDefined();
		expect(init.serverInfo.name).toBe("pi-commandcode-bridge");
		expect(init.protocolVersion).toBe("2025-06-18");

		const ping = ShimProc.ok(await shim.rpc("ping"));
		expect(ping).toEqual({});

		const listed = ShimProc.ok(await shim.rpc("tools/list"));
		expect(listed.tools).toHaveLength(1);
		expect(listed.tools[0]!.name).toBe("subagent_run");
		expect(listed.tools[0]!.inputSchema).toEqual(TOOLS[0]!.inputSchema);

		expect(broker.calls.length).toBe(0);
	} finally {
		shim.kill();
	}
});

test("shim parks tools/call until the broker answers, then maps the result to MCP", async () => {
	const broker = fakeBroker(sandboxDir());
	const shim = new ShimProc(broker.socketPath);
	try {
		const pending = shim.rpc("tools/call", {
			name: "subagent_run",
			arguments: { agent: "writer", task: "do the thing" },
		});
		// Parked: no MCP response while the bridge has not answered.
		let answered = false;
		void pending.then(() => (answered = true));
		await Bun.sleep(150);
		expect(answered).toBe(false);

		expect(broker.calls.length).toBe(1);
		expect(broker.calls[0]!.name).toBe("subagent_run");
		expect(broker.calls[0]!.arguments).toEqual({ agent: "writer", task: "do the thing" });

		broker.respond(0, { content: [{ type: "text", text: "DELEGATED OK" }], isError: false });
		const result = ShimProc.ok(await pending);
		expect(result.isError ?? false).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "DELEGATED OK" }]);
	} finally {
		shim.kill();
	}
});

test("shim forwards PICC_BRIDGE_CHILD as the child nonce of every call frame", async () => {
	const broker = fakeBroker(sandboxDir());
	const shim = new ShimProc(broker.socketPath, { PICC_BRIDGE_CHILD: "nonce-from-cmd-env" });
	try {
		const pending = shim.rpc("tools/call", { name: "subagent_run", arguments: {} });
		await Bun.sleep(120);
		expect(broker.calls.length).toBe(1);
		expect(broker.calls[0]!.child).toBe("nonce-from-cmd-env");
		broker.respond(0, { content: [{ type: "text", text: "ok" }], isError: false });
		ShimProc.ok(await pending);
	} finally {
		shim.kill();
	}
});

test("shim maps a broker error result to MCP isError and keeps serving", async () => {
	const broker = fakeBroker(sandboxDir());
	const shim = new ShimProc(broker.socketPath);
	try {
		const pending = shim.rpc("tools/call", { name: "subagent_run", arguments: {} });
		await Bun.sleep(120);
		broker.respond(0, { content: [{ type: "text", text: "boom" }], isError: true });
		const result = ShimProc.ok(await pending);
		expect(result.isError ?? false).toBe(true);
		expect(result.content[0].text).toBe("boom");

		expect(ShimProc.ok(await shim.rpc("ping"))).toEqual({});
	} finally {
		shim.kill();
	}
});

test("shim survives malformed lines and unknown methods", async () => {
	const broker = fakeBroker(sandboxDir());
	const shim = new ShimProc(broker.socketPath);
	try {
		shim.stdin("{not json at all", JSON.stringify({ jsonrpc: "2.0", id: 99, method: "prompts/list" }));
		const seen: Record<string, any>[] = [];
		for (let i = 0; i < 2; i++) {
			const line = await shim.line(5000);
			seen.push(JSON.parse(line!));
		}
		const parseError = seen.find((r) => r.id === null && r.error?.code === -32700);
		expect(parseError).toBeDefined();
		const unknown = seen.find((r) => r.id === 99);
		expect(unknown!.error?.code).toBe(-32601);
		expect(ShimProc.ok(await shim.rpc("ping"))).toEqual({});
	} finally {
		shim.kill();
	}
});

test("shim answers isError when the broker goes away mid-call", async () => {
	const broker = fakeBroker(sandboxDir());
	const shim = new ShimProc(broker.socketPath);
	const pending = shim.rpc("tools/call", { name: "subagent_run", arguments: {} });
	await Bun.sleep(120);
	broker.server.close();
	const result = ShimProc.ok(await pending);
	expect(result.isError ?? false).toBe(true);
	expect(String(result.content?.[0]!.text ?? "")).toContain("bridge");
});

test("an unknown tool name answers in-shim without touching the broker", async () => {
	const broker = fakeBroker(sandboxDir());
	const shim = new ShimProc(broker.socketPath);
	try {
		const reply = await shim.rpc("tools/call", { name: "definitely_not_a_tool", arguments: {} });
		expect(reply.error?.code).toBe(-32602);
		expect(broker.calls.length).toBe(0);
	} finally {
		shim.kill();
	}
});
