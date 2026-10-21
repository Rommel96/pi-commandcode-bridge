/**
 * Broker contract tests (issue #1): parked MCP calls, name de-mangling,
 * respond/rejectAll, and the shim spawn command. Uses a raw socket client so
 * the shim's own behavior is not in the way.
 */
import net from "node:net";
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, expect } from "bun:test";
import { startBroker, resultToMcpContent, shimPath, shimRuntime, type BrokerCall } from "../src/mcp/broker.js";

const TOOLS = [
	{ name: "subagent_run", description: "Delegate", parameters: { type: "object", properties: { task: { type: "string" } } } },
];

const dirs: string[] = [];
function sandboxDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "picc-broker-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let nextFrameSeq = 1;

/** Raw MCP-stdio-side client speaking the broker's ipc protocol. */
class RawShim {
	socket: net.Socket;
	out: Array<Record<string, any>> = [];
	waiters: Array<(v: Record<string, any>) => void> = [];
	constructor(socketPath: string, private token?: string) {
		this.socket = net.connect(socketPath);
		this.socket.setNoDelay(true);
		let buffer = "";
		this.socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let idx = buffer.indexOf("\n");
			while (idx >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				idx = buffer.indexOf("\n");
				if (line.trim()) {
					const frame = JSON.parse(line);
					this.out.push(frame);
					for (const w of this.waiters.splice(0)) w(frame);
				}
			}
		});
	}
	call(name: string, args: unknown, id?: string): void {
		const frameId = id ?? `frame-${nextFrameSeq++}`;
		this.socket.write(JSON.stringify({ v: 1, id: frameId, kind: "call", name, arguments: args, token: this.token, ppid: process.pid }) + "\n");
	}
	reply(msTimeout = 5000): Promise<Record<string, any> | null> {
		return new Promise((resolve) => {
			let done = false;
			const timer = setTimeout(() => {
				if (!done) {
					done = true;
					resolve(null);
				}
			}, msTimeout);
			this.waiters.push((frame) => {
				if (!done) {
					done = true;
					clearTimeout(timer);
					resolve(frame);
				}
			});
		});
	}
	close(): void {
		this.socket.destroy();
	}
}

test("broker exposes shim spawn args with the tool definitions base64-encoded", () => {
	const broker = startBroker({ tools: TOOLS, onCall: () => {} });
	broker.bindChild(process.pid);
	try {
		const { command, args, env } = broker.shimCommand();
		expect(command).toBe(shimRuntime());
		expect(args).toEqual([shimPath()]);
		expect(existsSync(shimPath())).toBe(true);
		const socketPath = env.PICC_SHIM_SOCKET;
		expect(typeof socketPath).toBe("string");
		const decoded = JSON.parse(readFileSync(env.PICC_SHIM_TOOLS_FILE as string, "utf8"));
		expect(statSync(env.PICC_SHIM_TOOLS_FILE as string).mode & 0o777).toBe(0o600);
		expect(decoded).toEqual([
			{ name: "subagent_run", description: "Delegate", inputSchema: { type: "object", properties: { task: { type: "string" } } } },
		]);
		const dir = statSync(path.dirname(socketPath!));
		expect((dir.mode & 0o777) === 0o700).toBe(true);
	} finally {
		broker.close();
	}
});

test("shim runtime falls back to node when process.execPath is Pi's binary", () => {
	expect(shimRuntime({}, "/home/lako/.local/share/pi/1.2.0/pi/pi")).toBe("node");
	expect(shimRuntime({}, "/usr/bin/node")).toBe("/usr/bin/node");
	expect(shimRuntime({}, "C:\\Program Files\\nodejs\\node.exe")).toBe("C:\\Program Files\\nodejs\\node.exe");
	expect(shimRuntime({ CMDCODE_BRIDGE_SHIM_RUNTIME: "/opt/custom/node" }, "/pi/pi")).toBe("/opt/custom/node");
});

test("broker parks calls, de-mangles the MCP tool name and resolves via respond", async () => {
	const seen: BrokerCall[] = [];
	const broker = startBroker({ tools: TOOLS, onCall: (call) => seen.push(call) });
	broker.bindChild(process.pid);
	const socketPath = broker.socketPath;
	const shim = new RawShim(socketPath, broker.shimCommand().env.PICC_SHIM_TOKEN);
	try {
		await new Promise((r) => setTimeout(r, 60));
		shim.call("mcp__pi-cmd-bridge-abc123__subagent_run", { task: "delegate this" });
		await new Promise((r) => setTimeout(r, 100));
		expect(seen.length).toBe(1);
		expect(seen[0]!.name).toBe("subagent_run");
		expect(seen[0]!.arguments).toEqual({ task: "delegate this" });
		expect(broker.pending).toHaveLength(1);
		expect(broker.pending[0]!.id).toBe(seen[0]!.id);

		const replyPromise = shim.reply();
		broker.respond(seen[0]!.id, { content: [{ type: "text", text: "PARKED-THEN-DONE" }], isError: false });
		const frame = await replyPromise;
		expect(frame).toEqual({
			v: 1,
			id: seen[0] ? frame?.id : "frame-1",
			kind: "result",
			content: [{ type: "text", text: "PARKED-THEN-DONE" }],
			isError: false,
		});
		expect(broker.pending).toHaveLength(0);
	} finally {
		shim.close();
		broker.close();
	}
});

test("broker rejects every parked call on rejectAll", async () => {
	const seen: BrokerCall[] = [];
	const broker = startBroker({ tools: TOOLS, onCall: (call) => seen.push(call) });
	broker.bindChild(process.pid);
	const shim = new RawShim(broker.socketPath, broker.shimCommand().env.PICC_SHIM_TOKEN);
	try {
		await new Promise((r) => setTimeout(r, 60));
		shim.call("subagent_run", {});
		const second = new RawShim(broker.socketPath, broker.shimCommand().env.PICC_SHIM_TOKEN);
		await new Promise((r) => setTimeout(r, 60));
		second.call("subagent_run", {});
		await new Promise((r) => setTimeout(r, 120));
		expect(broker.pending).toHaveLength(2);

		broker.rejectAll("bridge closed");
		const first = await shim.reply();
		const callFrame = await second.reply();
		expect(first!.isError).toBe(true);
		expect(callFrame!.isError).toBe(true);
		expect(first!.content[0].text).toContain("bridge closed");
		expect(callFrame!.content[0].text).toContain("bridge closed");
		expect(broker.pending).toHaveLength(0);
		second.close();
	} finally {
		shim.close();
		broker.close();
	}
});

test("a completed broker cannot reach out: respond is a no-op after close", async () => {
	const seen: BrokerCall[] = [];
	const broker = startBroker({ tools: TOOLS, onCall: (call) => seen.push(call) });
	broker.bindChild(process.pid);
	const socketPath = broker.socketPath;
	await new Promise((r) => setTimeout(r, 60));
	broker.close();
	expect(() => {
		statSync(socketPath);
	}).toThrow();

	// New bridge on the same directory works (the socket file was removed).
	const second = startBroker({ tools: TOOLS, onCall: (call) => seen.push(call) });
	shimClosed(second);
});

function shimClosed(broker: ReturnType<typeof startBroker>): void {
	const shim = new RawShim(broker.socketPath, broker.shimCommand().env.PICC_SHIM_TOKEN);
	shim.close();
	broker.close();
}

test("resultToMcpContent flattens tool result bodies for MCP", () => {
	expect(resultToMcpContent("plain string")).toEqual([{ type: "text", text: "plain string" }]);
	expect(
		resultToMcpContent([{ type: "text", text: "hi" }, { type: "image", data: "abc", mimeType: "image/png" }, { type: "thinking", thinking: "nope" }]),
	).toEqual([
		{ type: "text", text: "hi" },
		{ type: "image", data: "abc", mimeType: "image/png" },
	]);
	expect(resultToMcpContent([])).toEqual([{ type: "text", text: "(no output)" }]);
});

test("respond with an unknown id is a no-op", () => {
	const broker = startBroker({ tools: TOOLS, onCall: () => {} });
	broker.bindChild(process.pid);
	try {
		expect(broker.pending).toHaveLength(0);
		broker.respond("never-a-call", { content: [{ type: "text", text: "x" }], isError: false });
		expect(broker.pending).toHaveLength(0);
	} finally {
		broker.close();
	}
});
