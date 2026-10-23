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
		const child = broker.childNonce;
		expect(typeof token).toBe("string");
		expect(token!.length).toBeGreaterThanOrEqual(32);
		expect(typeof child).toBe("string");
		expect(child.length).toBeGreaterThanOrEqual(16);

		const legit = await connect(broker.socketPath);
		const intruder = await connect(broker.socketPath);
		legit.socket.write(JSON.stringify({ v: 1, kind: "call", id: "l1", name: "read", arguments: {}, token, child }) + "\n");
		intruder.socket.write(JSON.stringify({ v: 1, kind: "call", id: "e1", name: "bash", arguments: {} }) + "\n");
		intruder.socket.write(JSON.stringify({ v: 1, kind: "call", id: "e2", name: "bash", arguments: {}, token: "guess", child }) + "\n");
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

test("broker refuses calls with a wrong or missing child nonce and accepts its own", async () => {
	// Concurrent sessions share cmd's local MCP scope, so another session's cmd
	// spawns this broker's shim too: it has the token but not the run's nonce.
	const received: string[] = [];
	const broker = startBroker({ tools: TOOLS, onCall: (call) => received.push(call.name) });
	try {
		const token = broker.shimCommand().env.PICC_SHIM_TOKEN;
		const child = broker.childNonce;

		const foreign = await connect(broker.socketPath);
		foreign.socket.write(JSON.stringify({ v: 1, kind: "call", id: "f1", name: "bash", arguments: {}, token, child: "another-runs-nonce" }) + "\n");
		await sleep(100);
		expect(received).toEqual([]);
		expect(foreign.seen()).toContain("another Pi session");

		const missing = await connect(broker.socketPath);
		missing.socket.write(JSON.stringify({ v: 1, kind: "call", id: "m1", name: "bash", arguments: {}, token }) + "\n");
		await sleep(100);
		expect(received).toEqual([]);
		expect(missing.seen()).toContain("another Pi session");

		const own = await connect(broker.socketPath);
		own.socket.write(JSON.stringify({ v: 1, kind: "call", id: "o1", name: "read", arguments: {}, token, child }) + "\n");
		await sleep(100);
		expect(received).toEqual(["read"]);
		expect(broker.pending).toHaveLength(1);

		foreign.socket.destroy();
		missing.socket.destroy();
		own.socket.destroy();
	} finally {
		broker.close();
	}
});
