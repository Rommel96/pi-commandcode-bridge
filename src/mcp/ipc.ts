/**
 * Broker transport: one line-JSON protocol over a unix socket (or a named pipe
 * on Windows). Each shim connection carries one call per frame:
 *
 *   shim (client)  ->  {"v":1,"id":"<nonce>","kind":"call","name":"subagent_run","arguments":{...},"token":"<session token>","child":"<run nonce>"}
 *   broker         ->  {"v":1,"id":"<nonce>","kind":"result","content":[...],"isError":false}
 *
 * The handler returns a Promise per call — a deferred: the broker (and later
 * the provider) parks the call until Pi's tool result arrives. Don't return too
 * early: the promise must resolve only once; `respond(id, ...)` is the manual
 * way to settle one from outside.
 *
 * When the server has a token, a frame without the exact token closes its
 * connection, and each result is written only to the connection that sent the
 * call: another local process that reaches the socket can neither inject calls
 * nor read results. Listen failures are reported through `ready`, never thrown
 * as an uncaught `error` event.
 */
import net from "node:net";
import { timingSafeEqual } from "node:crypto";
import { unlinkSync } from "node:fs";
import type { Tool } from "@earendil-works/pi-ai";

export type IpcContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface IpcBrokerCall {
	kind: "call";
	v: 1;
	/** Correlation id; stable across the parked chain (the shim forwards it back). */
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/** Per-run child nonce the shim inherited from the spawned `cmd` process. */
	child?: string;
}

export interface IpcBrokerResult {
	/** The content blocks handed back to the calling model (text or image). */
	content: IpcContent[];
	isError?: boolean;
}

export type IpcRouteHandler = (call: IpcBrokerCall) => IpcBrokerResult | Promise<IpcBrokerResult>;

export interface IpcServer {
	/** The endpoint the shim was pointed at (unix socket file, or `\\.\pipe\<name>`). */
	path: string;
	/** Resolves once listening; rejects on the first listen error and never throws. */
	ready: Promise<void>;
	/** Settle one parked call out-of-band (same id the shim used). */
	respond: (id: string, result: IpcBrokerResult) => void;
	close: () => void;
}

/** Map Pi tool declarations to the shim's `tools` payload (typebox parameters ARE a JSON schema). */
export function toolDefs(
	tools: readonly Tool[],
): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description ?? "",
		inputSchema: (tool.parameters ?? {}) as unknown as Record<string, unknown>,
	}));
}

const FRAME_LIMIT = 1024 * 1024;

function isPipeEndpoint(path: string): boolean {
	return path.startsWith("\\\\");
}

/** Start a passive broker transport. `path` may be a unix socket file or a `\\.\pipe\<name>`. */
export function startIpcServer(path: string, handler: IpcRouteHandler, options: { token?: string } = {}): IpcServer {
	const expected = options.token ? Buffer.from(options.token, "utf8") : undefined;
	const authorized = (token: unknown): boolean => {
		if (!expected) return true;
		if (typeof token !== "string") return false;
		const given = Buffer.from(token, "utf8");
		return given.length === expected.length && timingSafeEqual(given, expected);
	};
	const conns = new Set<net.Socket>();
	const parked = new Map<string, (result: IpcBrokerResult) => void>();
	let closed = false;

	let readySettled = false;
	let resolveReady = (): void => {};
	let rejectReady = (_error: Error): void => {};
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	// The exposed promise is the only channel for a listen failure; keep it from
	// becoming an unhandled rejection when a caller ignores readiness.
	ready.catch(() => {});

	const server = net.createServer((conn) => {
		conns.add(conn);
		conn.on("close", () => conns.delete(conn));
		let buffer = "";
		conn.setEncoding("utf8");
		conn.on("data", (chunk: string) => {
			buffer += chunk;
			let idx = buffer.indexOf("\n");
			while (idx >= 0) {
				let line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				idx = buffer.indexOf("\n");
				if (line.trim()) routeLine(conn, line);
			}
		});
		conn.on("error", () => {
			/* the shim may vanish while a parked call waits */
		});
	});

	/** One JSON line from the shim: validate, park on the handler's deferred. */
	function routeLine(conn: net.Socket, line: string): void {
		let parsed: Record<string, unknown> | null = null;
		try {
			parsed = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return; // the shim only sends well-formed frames
		}
		if (!authorized(parsed.token)) {
			conn.destroy();
			return;
		}
		const id = typeof parsed.id === "string" ? parsed.id : "";
		const name = typeof parsed.name === "string" ? parsed.name : "";
		if (parsed.kind !== "call" || !id || !name) {
			send(conn, { content: [{ type: "text", text: "malformed router frame" }], isError: true });
			return;
		}
		if (parked.has(id)) return; // a shim never re-uses an id before the result arrives
		const args =
			parsed.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments)
				? (parsed.arguments as Record<string, unknown>)
				: {};
		const settle = (result: IpcBrokerResult): void => {
			parked.delete(id);
			send(conn, { id, content: result.content, isError: result.isError });
		};
		parked.set(id, settle);
		try {
			const child = typeof parsed.child === "string" ? parsed.child : undefined;
			void Promise.resolve(handler({ kind: "call", v: 1, id, name, arguments: args, child })).then(settle, (error: unknown) => {
				settle({
					content: [{ type: "text", text: `bridge failure: ${String((error as Error)?.message ?? error)}` }],
					isError: true,
				});
			});
		} catch (error) {
			settle({
				content: [{ type: "text", text: `bridge failure: ${String((error as Error)?.message ?? error)}` }],
				isError: true,
			});
		}
	}

	/** Write one result frame to the connection that sent the call. */
	function send(conn: net.Socket, frame: { id?: string; content?: unknown; isError?: boolean }): void {
		if (closed || conn.destroyed || conn.writableLength > FRAME_LIMIT) return;
		conn.write(
			JSON.stringify({ v: 1, id: frame.id ?? "", kind: "result", content: frame.content ?? [], isError: Boolean(frame.isError) }) + "\n",
		);
	}

	// A listen failure (EACCES, ENOENT, EADDRINUSE...) must never surface as an
	// uncaught `error` event: it settles `ready` instead. The persistent listener
	// also keeps later server-level errors from escaping.
	server.on("error", (error: Error) => {
		if (readySettled) return;
		readySettled = true;
		rejectReady(error);
	});
	server.once("listening", () => {
		if (readySettled) return;
		readySettled = true;
		resolveReady();
	});

	// A stale socket file from a crashed previous run fails listen() with EADDRINUSE; unlink first.
	if (!isPipeEndpoint(path)) {
		try {
			unlinkSync(path);
		} catch {
			/* nothing to unlink */
		}
	}
	try {
		server.listen(path);
	} catch (error) {
		if (!readySettled) {
			readySettled = true;
			rejectReady(error as Error);
		}
	}

	return {
		path,
		ready,
		respond: (id, result) => {
			const settle = parked.get(id);
			if (settle) settle(result);
		},
		close: () => {
			for (const conn of conns) conn.destroy();
			conns.clear();
			parked.clear();
			closed = true;
			try {
				server.close();
				if (!isPipeEndpoint(path)) {
					try {
						unlinkSync(path);
					} catch {
						/* gone already */
					}
				}
			} catch {
				/* server may never have bound */
			}
		},
	};
}
