#!/usr/bin/env node
/**
 * MCP stdio shim for pi-commandcode-bridge (issue #1).
 *
 * `cmd` spawns this file as its MCP server (stdio transport). Tool calls are
 * NOT answered here: they are forwarded over a unix socket (or named pipe) to
 * the broker inside the Pi host process and parked until the bridged Pi tool
 * result arrives; that is what lets the cmd model yield tool calls back to Pi.
 *
 * Kept dependency-free ON PURPOSE (plain node / bun, no build step).
 * Configuration arrives on argv only:
 *
 *   node shim.js --socket <unix file | \\.\pipe\<name>> --tools <base64-json>
 *
 *   --socket  broker endpoint (unix socket file or \\.\pipe\<name>)
 *   --tools   base64 JSON of the advertised tool definitions
 *             [{name, description?, inputSchema?}, ...]; env PICC_SHIM_TOOLS
 *             may carry the same payload (argv wins).
 */
import net from "node:net";

const SERVER_INFO = { name: "pi-commandcode-bridge", version: "0.2.0" };

// ---------------------------------------------------------------------------
// argv configuration
// ---------------------------------------------------------------------------

function fail(message) {
	process.stderr.write(`[pi-commandcode-bridge-shim] ${message}\n`);
	process.exit(2);
}

function parseArgs(argv, env) {
	const valueFor = (flag) => {
		const i = argv.indexOf(flag);
		return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
	};
	const socket = valueFor("--socket") || env.PICC_SHIM_SOCKET;
	if (!socket) fail("shim: --socket (or PICC_SHIM_SOCKET) is required");
	const toolsB64 = valueFor("--tools") || env.PICC_SHIM_TOOLS;
	if (!toolsB64) fail("shim: --tools <base64-json> (or PICC_SHIM_TOOLS) is required");
	let tools;
	try {
		tools = JSON.parse(Buffer.from(toolsB64, "base64").toString("utf8"));
	} catch {
		fail("shim: --tools must decode to a JSON array");
	}
	if (!Array.isArray(tools)) fail("shim: --tools must decode to a JSON array");
	// Optional only for standalone use; the bridge always sets it.
	const token = env.PICC_SHIM_TOKEN || undefined;
	return { socket, tools, token };
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC over stdio (hand-rolled: a tiny surface, no SDK)
// ---------------------------------------------------------------------------

const ERR_METHOD = -32601;
const ERR_PARAMS = -32602;
const ERR_INTERNAL = -32603;

const isRequest = (msg) =>
	msg && typeof msg === "object" && typeof msg?.method === "string" &&
	(typeof msg?.id === "number" || typeof msg?.id === "string");

// ---------------------------------------------------------------------------
// Broker link: one connection; each forwarded call parks until the result frame
// ---------------------------------------------------------------------------

class RouterLink {
	#endpoint;
	#socket = null;
	#connecting = null;
	#token;
	#parked = new Map(); // ipc frame id -> onResult({content,isError})

	constructor(endpoint, token) {
		this.#endpoint = endpoint;
		this.#token = token;
	}

	/** Connect (or reuse). Resolves with the socket. */
	#connect() {
		if (this.#socket?.writable && !this.#socket?.destroyed) {
			this.#connecting = null;
			return Promise.resolve(this.#socket);
		}
		if (this.#connecting) return this.#connecting;
		this.#connecting = new Promise((resolve, reject) => {
			const socket = net.connect(this.#endpoint);
			socket.setNoDelay(true);
			const fail = (why) => {
				this.#connecting = null;
				this.#socket = null;
				const parked = [...this.#parked.entries()];
				this.#parked.clear();
				for (const [, onResult] of parked) {
					onResult({ content: [{ type: "text", text: `bridge unreachable (${why})` }], isError: true });
				}
				reject(new Error(`bridge unreachable (${why})`));
			};
			socket.setTimeout(10_000, () => {
				socket.destroy();
				fail("connect timeout");
			});
			socket.once("connect", () => {
				socket.setTimeout(0);
				let buffer = "";
				socket.on("data", (chunk) => {
					buffer += chunk.toString("utf8");
					let idx = buffer.indexOf("\n");
					while (idx >= 0) {
						const line = buffer.slice(0, idx).trim();
						buffer = buffer.slice(idx + 1);
						idx = buffer.indexOf("\n");
						if (line) this.#route(line);
					}
				});
				socket.on("error", () => {
					/* handled by 'close' */
				});
				socket.on("close", () => fail("router connection closed"));
				this.#socket = socket;
				this.#connecting = null;
				resolve(socket);
			});
			socket.on("error", (error) => fail(error?.code ?? "connect failed"));
		});
		return this.#connecting;
	}

	#route(line) {
		let frame;
		try {
			frame = JSON.parse(line);
		} catch {
			return;
		}
		if (!frame || frame.kind !== "result" || typeof frame.id !== "string") return;
		const unAnswer = this.#parked.get(frame.id);
		if (!unAnswer) return;
		this.#parked.delete(frame.id);
		unAnswer({
			content: Array.isArray(frame.content) ? frame.content : [],
			isError: Boolean(frame.isError),
		});
	}

	/** Forward one MCP tools/call; the returned Promise is the parked result. */
	async call(name, args) {
		const socket = await this.#connect();
		const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		return new Promise((resolve) => {
			this.#parked.set(id, resolve);
			socket.write(JSON.stringify({ v: 1, id, kind: "call", name, arguments: args, token: this.#token }) + "\n");
		});
	}

	close() {
		if (this.#socket) {
			this.#socket.destroy();
			this.#socket = null;
		}
	}
}

// ---------------------------------------------------------------------------
// stdio routing loop
// ---------------------------------------------------------------------------

export function main(argv = process.argv.slice(2), env = process.env) {
	const { socket, tools, token } = parseArgs(argv, env);
	const link = new RouterLink(socket, token);
	const known = new Set(tools.map((t) => t.name));

	const onRequest = (id, method, params) => {
		if (method === "initialize") {
			reply(id, {
				// Echo the version the host asked for: MCP servers declare matches when supported.
				protocolVersion: typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: SERVER_INFO,
			});
			return;
		}
		if (method === "ping") {
			reply(id, {});
			return;
		}
		if (method === "tools/list") {
			reply(id, {
				tools: tools.map((t) => ({
					name: t.name,
					description: t.description ?? "",
					inputSchema: t.inputSchema ?? { type: "object" },
				})),
			});
			return;
		}
		if (method === "tools/call") {
			const name = typeof params?.name === "string" ? params.name : "";
			const args = params?.arguments && typeof params?.arguments === "object" && !Array.isArray(params?.arguments)
				? params?.arguments
				: {};
			if (!known.has(name)) {
				onError(id, ERR_PARAMS, `unknown tool: ${name || "(none)"}`);
				return;
			}
			link
				.call(name, args)
				.then((result) => reply(id, result))
				.catch((error) => onError(id, ERR_INTERNAL, String(error?.message ?? error)));
			return;
		}
		onError(id, ERR_METHOD, `method not supported: ${method}`);
	};

	function reply(id, result) {
		try {
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
		} catch {
			/* stdout gone */
		}
	}
	function onError(id, code, message) {
		try {
			process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
		} catch {
			/* stdout gone */
		}
	}

	let pending = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		pending += chunk;
		let idx = pending.indexOf("\n");
		while (idx >= 0) {
			const line = pending.slice(0, idx);
			pending = pending.slice(idx + 1);
			idx = pending.indexOf("\n");
			const trimmed = line.trim();
			if (!trimmed) continue;
			let msg = null;
			try {
				msg = JSON.parse(trimmed);
			} catch {
				writeJson({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
				continue;
			}
			if (isRequest(msg)) onRequest(msg.id, msg.method, msg.params);
			// notifications (no id) produce no response
		}
	});
	process.stdin.on("end", () => {
		link.close();
		process.exit(0);
	});

	function writeJson(frame) {
		try {
			process.stdout.write(JSON.stringify(frame) + "\n");
		} catch {
			/* stdout gone */
		}
	}
	return { link };
}

const invokedDirectly = process.argv[1]?.endsWith("shim.js");
if (invokedDirectly) {
	main();
}
