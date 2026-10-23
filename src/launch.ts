/**
 * Turn a CLI name or path into something `spawn` can start without a shell.
 *
 * On Windows `cmdc` is an npm `.cmd` shim: `spawn("cmdc")` fails with ENOENT,
 * `spawn("cmdc.cmd")` with EINVAL (and Node refuses `.cmd` without a shell),
 * and a shell mangles the JSON argument of `cmdc mcp add-json <name> <json>`.
 * The resolver reads the shim and launches the Node entry script it names.
 */
import * as fs from "node:fs";
import path from "node:path";

export interface Launch {
	/** Executable to spawn. */
	command: string;
	/** Arguments placed before the CLI arguments. */
	args: string[];
}

/** The fs calls the resolver needs; injectable for tests. */
export type LaunchFs = Pick<typeof fs, "readFileSync" | "statSync">;

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const NODE_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const SHIM_EXTENSIONS = new Set([".cmd", ".bat"]);
/** A shim or script larger than this is not one; never read it into memory. */
const MAX_TEXT_FILE_BYTES = 256 * 1024;
/** `"%dp0%\node_modules\command-code\dist\cli.mjs"` (new shims) or `"%~dp0\..\cli.mjs"` (old ones). */
const DP0_PREFIX_SOURCE = "(?:%(?:~)?dp0%|%~dp0)";
const DP0_QUOTED = new RegExp(`"(${DP0_PREFIX_SOURCE}[^"]*)"`, "gi");
const DP0_PREFIX = new RegExp(`^${DP0_PREFIX_SOURCE}`, "i");

/**
 * Runtime for a Node script. Pi's compiled binary sets `process.execPath` to
 * itself, which cannot run a script, so anything that is not a plain node/bun
 * executable falls back to `node` from PATH.
 */
export function nodeRuntime(
	env: NodeJS.ProcessEnv = process.env,
	execPath: string = process.execPath,
): string {
	const override = env.CMDCODE_BRIDGE_SHIM_RUNTIME;
	if (override) return override;
	const base = (execPath.split(/[\\/]/).pop() ?? "").toLowerCase();
	if (base === "node" || base === "node.exe" || base === "bun" || base === "bun.exe") return execPath;
	return "node";
}

function isFile(file: string, fsLike: LaunchFs): boolean {
	try {
		return fsLike.statSync(file).isFile();
	} catch {
		return false;
	}
}

function readText(file: string, fsLike: LaunchFs): string | undefined {
	try {
		if (fsLike.statSync(file).size > MAX_TEXT_FILE_BYTES) return undefined;
		return fsLike.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

function hasNodeShebang(file: string, fsLike: LaunchFs): boolean {
	const ext = path.extname(file).toLowerCase();
	if (NODE_EXTENSIONS.has(ext) || SHIM_EXTENSIONS.has(ext) || ext === ".exe" || ext === ".com") return false;
	const content = readText(file, fsLike);
	if (content === undefined) return false;
	const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
	return /^#!.*\bnode(?:js)?\b/.test(firstLine);
}

/** Environment lookup with Windows' case-insensitive names (`Path` vs `PATH`). */
function envValue(env: NodeJS.ProcessEnv, name: string): string {
	// Windows env keys are case-insensitive (`Path`); skip keys present without a value.
	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name && env[candidate] !== undefined);
	return key === undefined ? "" : (env[key] ?? "");
}

/** Existing file for `name` in `dir`, tolerating a case-insensitive filesystem on any host. */
function existingFile(dir: string, name: string, fsLike: LaunchFs): string | undefined {
	const direct = path.join(dir, name);
	const lower = path.join(dir, name.toLowerCase());
	// Windows is case-insensitive, so prefer the lowercase spelling and keep
	// the result deterministic when the host filesystem is not.
	if (lower !== direct && isFile(lower, fsLike)) return lower;
	return isFile(direct, fsLike) ? direct : undefined;
}

/**
 * The Node entry script an npm cmd-shim launches: the quoted `%dp0%` path on
 * the line that forwards `%*`, skipping the shim's own `node.exe` probe.
 */
function shimScript(content: string): string | undefined {
	const candidates: string[] = [];
	for (const line of content.split(/\r?\n/)) {
		if (!line.includes("%*")) continue;
		for (const match of line.matchAll(DP0_QUOTED)) candidates.push(match[1]!);
	}
	for (let index = candidates.length - 1; index >= 0; index--) {
		const candidate = candidates[index]!;
		if (!/\.(?:exe|com|cmd|bat)$/i.test(candidate)) return candidate;
	}
	return candidates[candidates.length - 1];
}

/** Resolve an npm `.cmd`/`.bat` shim to `node <entry script>` (no shell). */
function resolveShim(shim: string, env: NodeJS.ProcessEnv, fsLike: LaunchFs): Launch {
	const content = readText(shim, fsLike) ?? "";
	const script = shimScript(content);
	if (script === undefined) {
		throw new Error(
			`cannot launch ${shim} without a shell; set CMDCODE_BRIDGE_BIN to the CLI's .js/.mjs entry script`,
		);
	}
	const dir = path.dirname(shim);
	const relative = script.replace(DP0_PREFIX, "").replace(/^[\\/]+/, "");
	const scriptPath = path.join(dir, ...relative.split(/[\\/]+/).filter(Boolean));
	// npm puts a node.exe next to the shim when it installed one; prefer it.
	const localNode = path.join(dir, "node.exe");
	const command = isFile(localNode, fsLike) ? localNode : nodeRuntime(env);
	return { command, args: [scriptPath] };
}

function resolveFile(file: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, fsLike: LaunchFs): Launch | undefined {
	const ext = path.extname(file).toLowerCase();
	if (SHIM_EXTENSIONS.has(ext)) {
		return platform === "win32" ? resolveShim(file, env, fsLike) : undefined;
	}
	if (NODE_EXTENSIONS.has(ext) || hasNodeShebang(file, fsLike)) {
		return { command: nodeRuntime(env), args: [file] };
	}
	return undefined;
}

/** Windows PATH lookup by name: PATHEXT candidates first, then the bare name. */
function searchWindowsPath(bin: string, env: NodeJS.ProcessEnv, fsLike: LaunchFs): Launch | undefined {
	const dirs = envValue(env, "PATH")
		.split(";")
		.map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
		.filter(Boolean);
	const extensions = (envValue(env, "PATHEXT") || DEFAULT_PATHEXT)
		.split(";")
		.map((ext) => ext.trim())
		.filter(Boolean)
		.map((ext) => (ext.startsWith(".") ? ext : `.${ext}`));

	for (const dir of dirs) {
		for (const ext of extensions) {
			const file = existingFile(dir, `${bin}${ext}`, fsLike);
			if (!file) continue;
			const lower = ext.toLowerCase();
			if (SHIM_EXTENSIONS.has(lower)) return resolveShim(file, env, fsLike);
			return { command: file, args: [] };
		}
		const bare = existingFile(dir, bin, fsLike);
		if (bare) {
			return hasNodeShebang(bare, fsLike)
				? { command: nodeRuntime(env), args: [bare] }
				: { command: bare, args: [] };
		}
	}
	return undefined;
}

/**
 * The command plus prefix arguments for one CLI launch. Never returns a shell:
 * `.cmd`/`.bat` shims become `node <entry script>`, so JSON arguments survive.
 */
export function resolveLaunch(
	bin: string,
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	fsLike: LaunchFs = fs,
): Launch {
	const pathLike = bin.includes("/") || bin.includes("\\") || path.isAbsolute(bin) || /^[A-Za-z]:/.test(bin);
	if (pathLike) {
		if (isFile(bin, fsLike)) {
			const resolved = resolveFile(bin, env, platform, fsLike);
			if (resolved) return resolved;
		}
		return { command: bin, args: [] };
	}
	if (platform === "win32") {
		const resolved = searchWindowsPath(bin, env, fsLike);
		if (resolved) return resolved;
	}
	return { command: bin, args: [] };
}
