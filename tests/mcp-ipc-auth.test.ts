import { test, expect } from "bun:test";
import net from "node:net";
import { startBroker } from "../src/mcp/broker.js";

const TOOLS = [{ name: "read", description: "", parameters: {} }, { name: "bash", description: "", parameters: {} }] as any;

function connect(socketPath: string): Promise<{ socket: net.Socket; seen: () => string }> {
	return new Promise((resolve) => {
		let seen = "";
		const socket = net.connect(socketPath, () => resolve({ socket, seen: () => seen }));
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => (seen += chunk));
		socket.on("error", () => {});
	});
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("broker rejects calls without the session token and routes results only to the caller", async () => {
	const received: string[] = [];
	const broker = startBroker({ tools: TOOLS, onCall: (call) => received.push(call.name) });
	try {
		const token = broker.shimCommand().env.PICC_SHIM_TOKEN;
		broker.bindChild(process.pid);
		expect(typeof token).toBe("string");
		expect(token!.length).toBeGreaterThanOrEqual(32);

		const legit = await connect(broker.socketPath);
		const intruder = await connect(broker.socketPath);
		legit.socket.write(JSON.stringify({ v: 1, kind: "call", id: "l1", name: "read", arguments: {}, token, ppid: process.pid }) + "\n");
		intruder.socket.write(JSON.stringify({ v: 1, kind: "call", id: "e1", name: "bash", arguments: {} }) + "\n");
		intruder.socket.write(JSON.stringify({ v: 1, kind: "call", id: "e2", name: "bash", arguments: {}, token: "guess" }) + "\n");
		await sleep(100);

		expect(received).toEqual(["read"]);
		broker.respond(broker.pending[0]!.id, { content: [{ type: "text", text: "TOP-SECRET" }] });
		await sleep(100);

		expect(legit.seen()).toContain("TOP-SECRET");
		expect(intruder.seen()).not.toContain("TOP-SECRET");
		legit.socket.destroy();
		intruder.socket.destroy();
	} finally {
		broker.close();
	}
});

test("broker refuses calls from a cmd process other than its own child", async () => {
	// Concurrent sessions share cmd's local MCP scope, so another session's cmd
	// spawns this broker's shim too: it has the token but a different parent.
	const received: string[] = [];
	const broker = startBroker({ tools: TOOLS, onCall: (call) => received.push(call.name) });
	try {
		const token = broker.shimCommand().env.PICC_SHIM_TOKEN;
		broker.bindChild(process.pid);
		const foreign = await connect(broker.socketPath);
		foreign.socket.write(JSON.stringify({ v: 1, kind: "call", id: "f1", name: "bash", arguments: {}, token, ppid: process.pid + 1 }) + "\n");
		await sleep(100);
		expect(received).toEqual([]);
		expect(foreign.seen()).toContain("another Pi session");
		foreign.socket.destroy();
	} finally {
		broker.close();
	}
});
