/**
 * The broker is the bridge-side half of the MCP round-trip (issue #1): it owns
 * the ipc transport, advertises the current turn's Pi tools to the shim, and
 * parks every forwarded MCP tool call until Pi executes it and the result comes
 * back on a later `streamSimple` turn.
 *
 * Parked calls are the deferred Promises of the bridge: the provider turns each
 * one into a Pi `toolCall` block and ends the turn with `stopReason: "toolUse"`.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Tool } from "@earendil-works/pi-ai";
import { nodeRuntime } from "../launch.js";
import { startIpcServer, toolDefs, type IpcBrokerResult, type IpcContent, type IpcServer } from "./ipc.js";

/** One parked call the provider must surface to Pi as a toolCall block. */
export interface BrokerCall {
	/** The Pi toolCall id (also the `toolCallId` of the matching toolResult). */
	id: string;
	/** The Pi tool name (MCP name-mangling removed). */
	name: string;
	arguments: Record<string, unknown>;
}

/** `mcp__pi-cmd-bridge-abc123__subagent_run` -> `subagent_run`; plain names pass through. */
export function piToolName(mcpName: string): string {
	if (mcpName.startsWith("mcp__")) {
		const parts = mcpName.split("__");
		if (parts.length >= 3) return parts.slice(2).join("__");
	}
	return mcpName;
}

export interface BrokerOptions {
	/** The Pi tools of this turn (already resolved from the transcript). */
	tools: readonly Tool[];
	/** Notified once per parked call, in arrival order. */
	onCall?: (call: BrokerCall) => void;
	/** Shim runtime override; defaults to the current executable. */
	runtime?: string;
	/** Endpoint platform; defaults to `process.platform`. Injectable for tests. */
	platform?: NodeJS.Platform;
	/** Endpoint override (tests); defaults to `brokerEndpoint(dir, platform)`. */
	endpoint?: string;
}

export interface Broker {
	/** Parked calls, in arrival order. */
	readonly pending: readonly BrokerCall[];
	/** Private (0700) temp directory owned by this run; removed on close. */
	readonly dir: string;
	/** The endpoint the shim connects to (unix socket file, or pipe name). */
	readonly socketPath: string;
	/** Per-run secret the spawned `cmd` child inherits as `PICC_BRIDGE_CHILD`. */
	readonly childNonce: string;
	/** Resolves once the endpoint accepts connections; rejects on a listen error. */
	readonly ready: Promise<void>;
	/** Command, args and env for the MCP stdio config; env points at the socket and the tools file. */
	shimCommand(): { command: string; args: string[]; env: Record<string, string> };
	/** Settle one parked call. No-op for unknown ids. */
	respond(id: string, result: IpcBrokerResult): void;
	/** Settle every parked call as an error (abort, superseded turn, teardown). */
	rejectAll(reason: string): void;
	close(): void;
}

/**
 * Resolve the shim script path relative to this module.
 *
 * `import.meta.url` stays the real file URL even when Pi (Gentle-Shell) loads
 * extensions through jiti from a `data:` URL; `import.meta.dir` and
 * `import.meta.filename` do not survive that loader.
 */
export function shimPath(): string {
	return fileURLToPath(new URL("./shim.js", import.meta.url));
}

/**
 * Runtime for the shim subprocess. Pi's compiled binary sets `process.execPath`
 * to itself, which cannot run a script, so anything that is not a plain
 * node/bun executable falls back to `node` from PATH. Shared with the CLI
 * launcher, which runs entry scripts the same way.
 */
export function shimRuntime(
	env: NodeJS.ProcessEnv = process.env,
	execPath: string = process.execPath,
): string {
	return nodeRuntime(env, execPath);
}

/**
 * The broker endpoint for a platform. Windows cannot listen on AF_UNIX here
 * (EACCES) but accepts a named pipe, so the shim gets a `\\.\pipe\` name there
 * and a socket file inside the run's private temp directory everywhere else.
 */
export function brokerEndpoint(
	dir: string,
	platform: NodeJS.Platform,
	id: string = randomBytes(8).toString("hex"),
): string {
	if (platform === "win32") return `\\\\.\\pipe\\pi-cmd-bridge-${id}`;
	return path.join(dir, "broker.sock");
}

/** Create the broker for one run: temp dir (0700) + ipc server + shim argv. */
export function startBroker(options: BrokerOptions): Broker {
	const { tools, onCall } = options;
	const platform = options.platform ?? process.platform;
	const dir = mkdtempSync(path.join(tmpdir(), "pi-cmd-bridge-"), { mode: 0o700 });
	const socketPath = options.endpoint ?? brokerEndpoint(dir, platform);
	/** broker call id -> ipc frame id. */
	const ids = new Map<string, string>();
	/** Parked calls in arrival order (id lookups included). */
	const pending: BrokerCall[] = [];
	/** Per-run secret the shim must send with every frame. */
	const token = randomBytes(32).toString("base64url");
	/** Per-run secret only the spawned `cmd` child inherits. */
	const childNonce = randomBytes(24).toString("base64url");

	const ipcServer: IpcServer = startIpcServer(socketPath, (call) => {
		if (call.child !== childNonce) {
			return errorResult("this tool belongs to another Pi session; use the tools of your own bridge server");
		}
		const id = `picc-${randomBytes(6).toString("base64url")}`;
		ids.set(id, call.id);
		pending.push({ id, name: piToolName(call.name), arguments: call.arguments });
		try {
			onCall?.({ id, name: piToolName(call.name), arguments: call.arguments });
		} catch {
			/* provider notification must never break the transport */
		}
		// The deferred: parked until Pi answers (respond) or the run is torn down.
		return new Promise<IpcBrokerResult>(() => {});
	}, { token });

	const ready = ipcServer.ready;
	// Failures are surfaced by `ready` (openBroker) without becoming unhandled.
	ready.catch(() => {});

	return {
		pending,
		dir,
		socketPath,
		childNonce,
		ready,
		shimCommand: () => {
			// Schemas go through a private file, not env: Linux caps each env/argv
			// string at 128 KiB, and this config also travels as one
			// `cmd mcp add-json` argument.
			const toolsFile = path.join(dir, "tools.json");
			writeFileSync(toolsFile, JSON.stringify(toolDefs(tools)), { mode: 0o600 });
			return {
				command: options.runtime ?? shimRuntime(),
				args: [shimPath()],
				env: { PICC_SHIM_SOCKET: socketPath, PICC_SHIM_TOOLS_FILE: toolsFile, PICC_SHIM_TOKEN: token },
			};
		},
		respond: (id, result: IpcBrokerResult) => {
			const frameId = ids.get(id);
			if (frameId === undefined) return;
			ids.delete(id);
			const index = pending.findIndex((call) => call.id === id);
			if (index >= 0) pending.splice(index, 1);
			ipcServer.respond(frameId, result);
		},
		rejectAll: (reason: string) => {
			for (const call of [...pending]) {
				const frameId = ids.get(call.id);
				ids.delete(call.id);
				if (frameId !== undefined) ipcServer.respond(frameId, errorResult(reason));
			}
			pending.length = 0;
		},
		close: () => {
			ids.clear();
			pending.length = 0;
			ipcServer.close();
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best effort cleanup */
			}
		},
	};
}

/**
 * Start a broker and wait until its endpoint accepts connections. On a listen
 * failure the broker is closed (temp dir removed) and the error is rethrown so
 * the caller can keep the run alive without bridged tools.
 */
export async function openBroker(options: BrokerOptions): Promise<Broker> {
	const broker = startBroker(options);
	try {
		await broker.ready;
		return broker;
	} catch (error) {
		broker.close();
		throw error;
	}
}

export function errorResult(reason: string): IpcBrokerResult {
	return { content: [{ type: "text", text: `bridge: ${reason}` }], isError: true };
}

/** Flatten a Pi toolResult message into MCP content blocks (text only; images pass through). */
export function resultToMcpContent(content: unknown): IpcContent[] {
	const blocks = Array.isArray(content) ? content : typeof content === "string" ? [content] : [];
	const out: IpcContent[] = [];
	for (const block of blocks) {
		const type = (block as { type?: string } | undefined)?.type;
		if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
			out.push({ type: "text", text: (block as { text: string }).text });
		} else if (type === "image") {
			const image = block as { data?: unknown; mimeType?: unknown };
			if (typeof image.data === "string" && typeof image.mimeType === "string") {
				out.push({ type: "image", data: image.data, mimeType: image.mimeType });
			}
		} else if (type === "toolCall" || type === "thinking") {
			// tool results carry text only in Pi; ignore other block kinds defensively
		} else if (typeof block === "string") {
			out.push({ type: "text", text: block });
		}
	}
	if (out.length === 0) out.push({ type: "text", text: "(no output)" });
	return out;
}
