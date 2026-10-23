import { spawn } from "node:child_process";
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveBin } from "./bin.js";
import { resolveLaunch } from "./launch.js";
import { FALLBACK_MODELS, type CmdEffort, type CmdModelSpec } from "./models.js";

/** One model of the live `cmd` catalog. `efforts: null` means the probe was inconclusive. */
export interface CatalogEntry {
	id: string;
	description: string;
	efforts: CmdEffort[] | null;
}

export interface CatalogSnapshot {
	version: 1;
	savedAt: number;
	models: CatalogEntry[];
}

const SNAPSHOT_VERSION = 1;
const DEFAULT_TTL_HOURS = 24;
const DEFAULT_CONCURRENCY = 8;
const LIST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;
const LIST_OUTPUT_CAP = 1_000_000;
const PROBE_OUTPUT_CAP = 8_192;
const LOCK_STALE_MS = 120_000;
const CMD_EFFORTS: readonly CmdEffort[] = ["off", "low", "medium", "high", "xhigh", "max"];

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
/**
 * `id  description`: ids may lack a vendor prefix (`gpt-6-luna`) or end in `:free`
 * (`stealth/glyph-cluster:free`); two or more spaces separate the columns.
 */
const MODEL_LINE = /^([A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)?)\s{2,}(\S.*)$/;
/** Everything after this line (usage hints, headless-only decision models) is not a chat model. */
const LIST_END = "Pass the full id";

function stripAnsi(text: string): string {
	return text.replace(ANSI, "");
}

/** Parse the output of `cmd --list-models` into `{ id, description }` pairs. */
export function parseModelList(text: string): Array<{ id: string; description: string }> {
	const entries: Array<{ id: string; description: string }> = [];
	const seen = new Set<string>();
	for (const raw of stripAnsi(text).split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith(LIST_END)) break;
		const match = MODEL_LINE.exec(line);
		if (!match || seen.has(match[1]!)) continue;
		seen.add(match[1]!);
		entries.push({ id: match[1]!, description: match[2]!.trim() });
	}
	return entries;
}

/**
 * Read the effort levels from the output of `cmd -p ... --effort bogus`:
 * `Unknown effort "bogus". Supported: low, high, max.` -> the list;
 * `<Model> has no adjustable reasoning effort.` -> []; anything else -> null.
 */
export function parseEffortProbe(text: string): CmdEffort[] | null {
	const output = stripAnsi(text);
	if (/no adjustable reasoning effort/i.test(output)) return [];
	const match = /Supported:\s*([^\n]+)/i.exec(output);
	if (!match) return null;
	const levels: CmdEffort[] = [];
	for (const word of match[1]!.split(/[,\s]+/)) {
		const level = word.replace(/[.;]+$/, "").toLowerCase() as CmdEffort;
		if (CMD_EFFORTS.includes(level) && !levels.includes(level)) levels.push(level);
	}
	return levels.length > 0 ? levels : null;
}

/** `... with 1M context` -> 1_000_000; `128K context` -> 128_000. */
export function contextFromDescription(description: string): number | undefined {
	const match = /(\d+(?:\.\d+)?)\s*([KM])\s*(?:-?\s*tokens?\s*)?context/i.exec(description);
	if (!match) return undefined;
	const factor = match[2]!.toUpperCase() === "M" ? 1_000_000 : 1_000;
	return Math.round(Number(match[1]) * factor);
}

/** Comma separated globs (`*` only) matched against the whole model id; empty matches everything. */
export function compileFilter(spec: string | undefined): (id: string) => boolean {
	const patterns = (spec ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.map((glob) => new RegExp(`^${glob.split("*").map(escapeRegex).join(".*")}$`, "i"));
	if (patterns.length === 0) return () => true;
	return (id) => patterns.some((pattern) => pattern.test(id));
}

function escapeRegex(text: string): string {
	return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

export function readSnapshot(file: string): CatalogSnapshot | null {
	try {
		const value = JSON.parse(readFileSync(file, "utf8")) as Partial<CatalogSnapshot>;
		if (value.version !== SNAPSHOT_VERSION || typeof value.savedAt !== "number" || !Array.isArray(value.models)) {
			return null;
		}
		for (const entry of value.models) {
			const efforts = (entry as CatalogEntry | undefined)?.efforts;
			if (!entry || typeof entry.id !== "string" || (efforts !== null && !Array.isArray(efforts))) return null;
		}
		return value as CatalogSnapshot;
	} catch {
		return null;
	}
}

/** Atomic write (temporary file, then rename) so a reader never sees a partial file. */
export function writeSnapshot(file: string, snapshot: CatalogSnapshot): void {
	mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, file);
	} catch (error) {
		try {
			unlinkSync(tmp);
		} catch {
			/* nothing to clean */
		}
		throw error;
	}
}

export function isFresh(snapshot: CatalogSnapshot, now: number, ttlMs: number): boolean {
	return now - snapshot.savedAt < ttlMs;
}

interface RunResult {
	code: number | null;
	output: string;
	error?: Error;
}

interface RunOptions {
	env: NodeJS.ProcessEnv;
	cwd: string;
	timeoutMs: number;
	cap: number;
	/** Do not keep the host process alive for this child (background refresh). */
	detach: boolean;
}

function run(bin: string, args: string[], options: RunOptions): Promise<RunResult> {
	return new Promise((resolve) => {
		let child;
		try {
			const launch = resolveLaunch(bin, options.env);
			child = spawn(launch.command, [...launch.args, ...args], {
				cwd: options.cwd,
				env: options.env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({ code: null, output: "", error: error as Error });
			return;
		}
		let output = "";
		const collect = (chunk: string): void => {
			if (output.length < options.cap) output += chunk;
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
		if (options.detach) {
			timer.unref();
			child.unref();
			(child.stdout as unknown as { unref?: () => void }).unref?.();
			(child.stderr as unknown as { unref?: () => void }).unref?.();
		}
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, output, error });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, output });
		});
	});
}

async function mapPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await work(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
	return results;
}

export interface DiscoverOptions {
	bin: string;
	/** Extra environment for the child processes, on top of `process.env`. */
	env: NodeJS.ProcessEnv;
	/** Neutral working directory: `cmd --trust` may create `.commandcode/` in its cwd. */
	cwd: string;
	concurrency?: number;
	/** Efforts of a previous snapshot, kept when a probe is inconclusive. */
	previous?: CatalogSnapshot | null;
	listTimeoutMs?: number;
	probeTimeoutMs?: number;
	detach?: boolean;
}

/**
 * Read the live catalog: `cmd --list-models`, then one cheap probe per model.
 * The probe passes an invalid `--effort`, which `cmd` rejects before reaching the
 * model, and the error names the supported levels.
 */
export async function discoverCatalog(options: DiscoverOptions): Promise<CatalogSnapshot> {
	const env = { ...process.env, ...options.env, CMD_HERDR: "0" };
	const detach = options.detach ?? false;
	const list = await run(options.bin, ["--list-models"], {
		env,
		cwd: options.cwd,
		timeoutMs: options.listTimeoutMs ?? LIST_TIMEOUT_MS,
		cap: LIST_OUTPUT_CAP,
		detach,
	});
	if (list.error || list.code !== 0) {
		throw new Error(`cmd --list-models failed: ${list.error?.message ?? `exit ${list.code}`}`);
	}
	const listed = parseModelList(list.output);
	if (listed.length === 0) throw new Error("cmd --list-models returned no models");

	const previous = new Map((options.previous?.models ?? []).map((entry) => [entry.id, entry]));
	const models = await mapPool(listed, options.concurrency ?? DEFAULT_CONCURRENCY, async (entry): Promise<CatalogEntry> => {
		const probe = await run(
			options.bin,
			["-p", "hi", "-m", entry.id, "--effort", "bogus", "--no-session", "--skip-onboarding", "--trust", "--max-turns", "1"],
			{ env, cwd: options.cwd, timeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS, cap: PROBE_OUTPUT_CAP, detach },
		);
		const efforts = probe.error ? null : parseEffortProbe(probe.output);
		return { ...entry, efforts: efforts ?? previous.get(entry.id)?.efforts ?? null };
	});
	return { version: SNAPSHOT_VERSION, savedAt: Date.now(), models };
}

/** Turn a snapshot into model specs: filtered, with efforts from the table when a probe was inconclusive. */
export function specsFromSnapshot(snapshot: CatalogSnapshot, filter: (id: string) => boolean): CmdModelSpec[] {
	const specs: CmdModelSpec[] = [];
	for (const entry of snapshot.models) {
		if (!filter(entry.id)) continue;
		const known = FALLBACK_MODELS.find((model) => model.id === entry.id);
		const contextWindow = contextFromDescription(entry.description) ?? known?.contextWindow;
		specs.push({
			id: entry.id,
			name: entry.id,
			efforts: entry.efforts ?? known?.efforts ?? [],
			description: entry.description,
			...(contextWindow !== undefined ? { contextWindow } : {}),
		});
	}
	return specs;
}

export function cachePath(env: NodeJS.ProcessEnv): string {
	if (env.CMDCODE_BRIDGE_CACHE) return env.CMDCODE_BRIDGE_CACHE;
	const agentDir = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "commandcode-bridge", "models-cache.json");
}

function ttlMs(env: NodeJS.ProcessEnv): number {
	const hours = Number(env.CMDCODE_BRIDGE_CACHE_TTL_HOURS);
	return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS) * 3_600_000;
}

function acquireLock(lock: string): boolean {
	mkdirSync(path.dirname(lock), { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fd = openSync(lock, "wx");
			writeSync(fd, String(process.pid));
			closeSync(fd);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
			try {
				// A lock older than any plausible refresh was left by a process that exited mid-way.
				if (Date.now() - statSync(lock).mtimeMs <= LOCK_STALE_MS) return false;
				unlinkSync(lock);
			} catch {
				return false;
			}
		}
	}
	return false;
}

async function refresh(env: NodeJS.ProcessEnv, file: string, previous: CatalogSnapshot | null, detach: boolean): Promise<CatalogSnapshot> {
	const cwd = path.dirname(file);
	mkdirSync(cwd, { recursive: true });
	const snapshot = await discoverCatalog({ bin: resolveBin(env), env, cwd, previous, detach });
	try {
		writeSnapshot(file, snapshot);
	} catch {
		/* a read-only cache directory only costs the next start another discovery */
	}
	return snapshot;
}

function refreshInBackground(env: NodeJS.ProcessEnv, file: string, previous: CatalogSnapshot | null): void {
	const lock = `${file}.lock`;
	if (!acquireLock(lock)) return;
	void refresh(env, file, previous, true)
		.catch(() => undefined)
		.finally(() => {
			try {
				unlinkSync(lock);
			} catch {
				/* already gone */
			}
		});
}

export interface LoadOptions {
	env: NodeJS.ProcessEnv;
}

/**
 * The models to register with Pi.
 *
 * - fresh cache: used as is, no `cmd` call;
 * - stale cache: used immediately while a detached refresh updates it for the next start;
 * - no cache, or `CMDCODE_BRIDGE_REFRESH=1`: discovery runs now (once), and the built-in
 *   table applies when `cmd` cannot be queried.
 */
export async function loadModelSpecs(options: LoadOptions): Promise<CmdModelSpec[]> {
	const { env } = options;
	const file = cachePath(env);
	const filter = compileFilter(env.CMDCODE_BRIDGE_MODELS);
	const cached = readSnapshot(file);
	const force = env.CMDCODE_BRIDGE_REFRESH === "1";

	if (cached && !force) {
		if (!isFresh(cached, Date.now(), ttlMs(env))) refreshInBackground(env, file, cached);
		return specsFromSnapshot(cached, filter);
	}
	try {
		return specsFromSnapshot(await refresh(env, file, cached, false), filter);
	} catch {
		return cached ? specsFromSnapshot(cached, filter) : FALLBACK_MODELS.filter((model) => filter(model.id));
	}
}
