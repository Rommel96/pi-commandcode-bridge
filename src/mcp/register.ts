/**
 * Register/unregister the bridge's shim with `cmd` through its own MCP
 * subcommands (issue #1). The server lives in the "local" scope
 * (`~/.commandcode/projects/<slug>/mcp.json`): machine-private, never inside
 * the user's repository, and reversible per run (`add-json` before spawn,
 * `remove` after the child exits).
 *
 * We deliberately do not rewrite that file ourselves: letting `cmd` decide
 * which entries exist (and how the project slug is derived) avoids duplicating
 * the CLI's own config logic. Names carry the `pi-cmd-bridge-` prefix so stale
 * entries from killed sessions can be identified and cleaned.
 */
import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";

/** Config name prefix for every bridge-registered MCP server. */
export const MCP_NAME_PREFIX = "pi-cmd-bridge-";

export interface StdioServerConfig {
	transport: "stdio";
	command: string;
	args: string[];
	env?: Record<string, string>;
}

interface CliResult {
	code: number | null;
	output: string;
}

function runCli(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<CliResult> {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawnChild(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ code: null, output: String((error as Error).message) });
			return;
		}
		let output = "";
		const collect = (chunk: Buffer | string): void => {
			output += chunk.toString("utf8");
		};
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		const timer = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already gone */
			}
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, output: String(error.message) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

/**
 * Deterministic, collision-resistant config name bound to one conversation and
 * to the owning Pi process. The pid lets other sessions tell a live entry from
 * a crashed leftover without touching it.
 */
export function mcpServerName(base: string): string {
	const digest = createHash("sha256").update(base).digest("hex").slice(0, 8);
	return `${MCP_NAME_PREFIX}${process.pid}-${digest}`;
}

/** Owner pid encoded in a bridge server name, or undefined for legacy names. */
function ownerPid(name: string): number | undefined {
	const match = /^(\d+)-[0-9a-f]+$/.exec(name.slice(MCP_NAME_PREFIX.length));
	return match ? Number(match[1]) : undefined;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Persist the shim as a local-scope MCP server. `add-json` overwrites an
 * existing entry, so re-registering after a restart self-heals.
 */
export async function registerMcpServer(
	bin: string,
	env: NodeJS.ProcessEnv,
	name: string,
	server: StdioServerConfig,
	cwd: string,
): Promise<{ ok: boolean; error?: string }> {
	const json = JSON.stringify(server);
	const result = await runCli(bin, ["mcp", "add-json", name, json, "-s", "local"], env, cwd, 30_000);
	if (result.code === 0) return { ok: true };
	return { ok: false, error: result.output.trim() || `cmd mcp add-json exited ${result.code}` };
}

/** Remove the bridge's own server entry; idempotent, failures ignored. */
export async function unregisterMcpServer(bin: string, env: NodeJS.ProcessEnv, name: string, cwd: string): Promise<void> {
	await runCli(bin, ["mcp", "remove", name, "-s", "local"], env, cwd, 30_000);
}

/** Columns of one `cmd mcp list` row (NAME, TYPE, SCOPE, AUTH, STATUS). */
function parseListRows(text: string): string[][] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !/^Total:/.test(line) && !/^MCP Servers$/i.test(line))
		.filter((line) => line.toLowerCase() !== "name")
		.map((line) => line.split(/\s{2,}/).map((column) => column.trim()))
		.filter((cells) => cells.length >= 3 && cells[0]!);
}

/**
 * Remove local-scope bridge servers left by sessions that crashed without
 * cleanup: entries whose owner process is gone, plus legacy names without an
 * owner pid. Entries of live Pi processes (other sessions in the same project)
 * are kept, otherwise concurrent sessions would delete each other's server.
 */
export async function removeStaleBridgeServers(bin: string, env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
	const result = await runCli(bin, ["mcp", "list"], env, cwd, 30_000);
	if (result.code !== 0) return;
	const rows = parseListRows(result.output);
	for (const cells of rows) {
		const [name, , scope] = cells;
		if (!name || !name.startsWith(MCP_NAME_PREFIX) || scope !== "local") continue;
		const pid = ownerPid(name);
		if (pid !== undefined && isAlive(pid)) continue;
		await unregisterMcpServer(bin, env, name, cwd);
	}
}

export type { StdioServerConfig as StdioServerConfigType };
