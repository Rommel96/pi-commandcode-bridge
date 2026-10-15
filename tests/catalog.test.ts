import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	compileFilter,
	contextFromDescription,
	discoverCatalog,
	isFresh,
	loadModelSpecs,
	parseEffortProbe,
	parseModelList,
	readSnapshot,
	specsFromSnapshot,
	writeSnapshot,
	type CatalogSnapshot,
} from "../src/catalog.js";
import { FALLBACK_MODELS, setActiveSpecs } from "../src/models.js";
import { sandbox, waitFor, type Sandbox } from "./helpers.js";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const CATALOG_STUB = path.join(FIXTURES, "cmd-catalog");
const REAL_LIST = readFileSync(path.join(FIXTURES, "list-models.txt"), "utf8");
const REAL_PROBES = JSON.parse(readFileSync(path.join(FIXTURES, "probes.json"), "utf8")) as Record<string, string>;
const HOUR = 3_600_000;

afterEach(() => setActiveSpecs(undefined));

interface CatalogBox {
	sb: Sandbox;
	env: Record<string, string>;
	cache: string;
	log: string;
}

function catalogBox(extra: Record<string, string> = {}): CatalogBox {
	const sb = sandbox();
	const cache = path.join(sb.dir, "cache", "models.json");
	const log = path.join(sb.dir, "calls.log");
	writeFileSync(log, "");
	return {
		sb,
		cache,
		log,
		env: {
			CMDCODE_BRIDGE_BIN: CATALOG_STUB,
			CMDCODE_BRIDGE_CACHE: cache,
			CMD_STUB_LIST: path.join(FIXTURES, "list-small.txt"),
			CMD_STUB_PROBES: path.join(FIXTURES, "probes-small.json"),
			CMD_STUB_LOG: log,
			...extra,
		},
	};
}

function calls(box: CatalogBox): Array<Record<string, any>> {
	return readFileSync(box.log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("parseModelList", () => {
	test("reads every `id  description` line of the real cmd output and nothing else", () => {
		const entries = parseModelList(REAL_LIST);
		const ids = entries.map((e) => e.id);
		const announced = Number(/(\d+) models/.exec(REAL_LIST)![1]); // cmd states its own count
		expect(entries.length).toBe(announced);
		expect(ids).toContain("stealth/glyph-cluster:free"); // ids can carry a `:free` suffix
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain("z-ai/glm-5.3-flash");
		expect(ids).toContain("gpt-6-luna"); // ids without a vendor prefix exist
		expect(entries.find((e) => e.id === "z-ai/glm-5.3-flash")!.description).toBe(
			"fast, affordable GLM coding with 1M context",
		);
		expect(ids).not.toContain("typesafe/jev"); // decision model, headless only
		expect(ids.some((id) => id.startsWith("Docs") || id.startsWith("Available"))).toBe(false);
	});

	test("tolerates ANSI color codes and CRLF", () => {
		const text = "\u001b[1mOpen Source\u001b[0m\r\n\r\n\u001b[32mvendor/model-a\u001b[0m   does things\r\n";
		expect(parseModelList(text)).toEqual([{ id: "vendor/model-a", description: "does things" }]);
	});

	test("returns an empty list for unrelated output", () => {
		expect(parseModelList("Error: not logged in\n")).toEqual([]);
		expect(parseModelList("")).toEqual([]);
	});
});

describe("parseEffortProbe", () => {
	test("reads the supported levels from the real probe outputs", () => {
		expect(parseEffortProbe(REAL_PROBES["z-ai/glm-5.3-flash"]!)).toEqual(["low", "high", "max"]);
		expect(parseEffortProbe(REAL_PROBES["deepseek/deepseek-v4.1-flash"]!)).toEqual(["off", "low", "high", "max"]);
		expect(parseEffortProbe(REAL_PROBES["xai/grok-4.7"]!)).toEqual(["low", "medium", "high", "xhigh"]);
		expect(parseEffortProbe(REAL_PROBES["gpt-6-luna"]!)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	test("a model without adjustable effort yields an empty list", () => {
		expect(parseEffortProbe(REAL_PROBES["xiaomi/mimo-v2.6-pro"]!)).toEqual([]);
	});

	test("unrecognized output yields null (unknown), never a guess", () => {
		expect(parseEffortProbe("")).toBeNull();
		expect(parseEffortProbe("Rate limited, try again\n")).toBeNull();
		expect(parseEffortProbe('Unknown effort "bogus". Supported: turbo, low.\n')).toEqual(["low"]);
	});
});

describe("contextFromDescription", () => {
	test("reads M and K hints", () => {
		expect(contextFromDescription("fast GLM coding with 1M context")).toBe(1_000_000);
		expect(contextFromDescription("small model with 128K context")).toBe(128_000);
		expect(contextFromDescription("agentic coding with a 262k context window")).toBe(262_000);
	});
	test("returns undefined without a hint", () => {
		expect(contextFromDescription("fast hybrid-attention reasoning")).toBeUndefined();
	});
});

describe("compileFilter", () => {
	test("empty or missing pattern list matches everything", () => {
		expect(compileFilter(undefined)("any/model")).toBe(true);
		expect(compileFilter("  ")("any/model")).toBe(true);
	});
	test("comma separated globs, matched against the whole id", () => {
		const f = compileFilter("deepseek/*, gpt-6-luna ,*glm-5.3-flash");
		expect(f("deepseek/deepseek-v4.1-flash")).toBe(true);
		expect(f("gpt-6-luna")).toBe(true);
		expect(f("z-ai/glm-5.3-flash")).toBe(true);
		expect(f("gpt-6-luna-pro")).toBe(false);
		expect(f("xiaomi/mimo-v2.6-pro")).toBe(false);
	});
	test("regex characters in a pattern are literal", () => {
		const f = compileFilter("vendor/model.a");
		expect(f("vendor/model.a")).toBe(true);
		expect(f("vendor/modelxa")).toBe(false);
	});
});

describe("snapshot cache", () => {
	const snapshot: CatalogSnapshot = {
		version: 1,
		savedAt: 1000,
		models: [{ id: "a/b", description: "d", efforts: ["low"] }],
	};

	test("round trips and leaves no temporary file behind", () => {
		const box = catalogBox();
		writeSnapshot(box.cache, snapshot);
		expect(readSnapshot(box.cache)).toEqual(snapshot);
		expect(readdirSync(path.dirname(box.cache))).toEqual(["models.json"]);
	});

	test("missing, corrupt or wrong-version files read as null", () => {
		const box = catalogBox();
		expect(readSnapshot(box.cache)).toBeNull();
		mkdirSync(path.dirname(box.cache), { recursive: true });
		writeFileSync(box.cache, "{not json");
		expect(readSnapshot(box.cache)).toBeNull();
		writeFileSync(box.cache, JSON.stringify({ ...snapshot, version: 99 }));
		expect(readSnapshot(box.cache)).toBeNull();
		writeFileSync(box.cache, JSON.stringify({ version: 1, savedAt: 1, models: "nope" }));
		expect(readSnapshot(box.cache)).toBeNull();
	});

	test("isFresh honors the TTL", () => {
		expect(isFresh(snapshot, 1000 + HOUR - 1, HOUR)).toBe(true);
		expect(isFresh(snapshot, 1000 + HOUR, HOUR)).toBe(false);
	});
});

describe("discoverCatalog", () => {
	test("lists models, probes each one and records the effort levels", async () => {
		const box = catalogBox();
		const snap = await discoverCatalog({ bin: CATALOG_STUB, env: box.env, cwd: box.sb.dir });
		const byId = Object.fromEntries(snap.models.map((m) => [m.id, m]));
		expect(snap.models.map((m) => m.id)).toEqual([
			"deepseek/deepseek-v4.1-flash",
			"xiaomi/mimo-v2.6-pro",
			"z-ai/glm-5.3-flash",
			"zai-org/glm-5.3",
			"vendor/tiny-model",
			"gpt-6-luna",
		]);
		expect(byId["z-ai/glm-5.3-flash"]!.efforts).toEqual(["low", "high", "max"]);
		expect(byId["xiaomi/mimo-v2.6-pro"]!.efforts).toEqual([]);
		expect(byId["zai-org/glm-5.3"]!.efforts).toBeNull(); // the stub has no probe text for it
		expect(snap.version).toBe(1);
	});

	test("probes are cheap and isolated: bogus effort, one turn, no session, CMD_HERDR=0, neutral cwd", async () => {
		const box = catalogBox();
		await discoverCatalog({ bin: CATALOG_STUB, env: box.env, cwd: box.sb.dir });
		const probes = calls(box).filter((c) => c.kind === "probe");
		expect(probes.length).toBe(6);
		for (const p of probes) {
			expect(p.argv).toContain("--effort");
			expect(p.argv[p.argv.indexOf("--effort") + 1]).toBe("bogus");
			expect(p.argv).toContain("--max-turns");
			expect(p.argv).toContain("--no-session");
			expect(p.argv).toContain("--skip-onboarding");
			expect(p.cmdHerdr).toBe("0");
			expect(p.cwd).toBe(readRealpath(box.sb.dir));
		}
		const list = calls(box).find((c) => c.kind === "list")!;
		expect(list.cwd).toBe(readRealpath(box.sb.dir));
	});

	test("never runs more probes at once than the concurrency limit", async () => {
		const box = catalogBox({ CMD_STUB_PROBE_DELAY_MS: "80" });
		await discoverCatalog({ bin: CATALOG_STUB, env: box.env, cwd: box.sb.dir, concurrency: 2 });
		const events = calls(box).filter((c) => c.kind === "probe" || c.kind === "probe-end");
		let active = 0;
		let peak = 0;
		for (const e of events.sort((a, b) => a.t - b.t || (a.kind === "probe-end" ? -1 : 1))) {
			active += e.kind === "probe" ? 1 : -1;
			peak = Math.max(peak, active);
		}
		expect(peak).toBeLessThanOrEqual(2);
		expect(peak).toBeGreaterThanOrEqual(2);
	});

	test("an unknown probe keeps the effort levels of the previous snapshot", async () => {
		const box = catalogBox();
		const previous: CatalogSnapshot = {
			version: 1,
			savedAt: 1,
			models: [{ id: "zai-org/glm-5.3", description: "old", efforts: ["low", "high", "max"] }],
		};
		const snap = await discoverCatalog({ bin: CATALOG_STUB, env: box.env, cwd: box.sb.dir, previous });
		expect(snap.models.find((m) => m.id === "zai-org/glm-5.3")!.efforts).toEqual(["low", "high", "max"]);
	});

	test("rejects when the model list cannot be read", async () => {
		const box = catalogBox({ CMD_STUB_LIST_FAIL: "1" });
		await expect(discoverCatalog({ bin: CATALOG_STUB, env: box.env, cwd: box.sb.dir })).rejects.toThrow();
		await expect(
			discoverCatalog({ bin: "/nonexistent/cmd", env: box.env, cwd: box.sb.dir }),
		).rejects.toThrow();
	});

	test("rejects when the list output has no models (for example a login prompt)", async () => {
		const box = catalogBox({ CMD_STUB_LIST: path.join(FIXTURES, "probes.json") });
		await expect(discoverCatalog({ bin: CATALOG_STUB, env: box.env, cwd: box.sb.dir })).rejects.toThrow(/no models/i);
	});
});

describe("specsFromSnapshot", () => {
	const snap: CatalogSnapshot = {
		version: 1,
		savedAt: 1,
		models: [
			{ id: "z-ai/glm-5.3-flash", description: "fast GLM with 1M context", efforts: ["low", "high", "max"] },
			{ id: "vendor/tiny-model", description: "small model with 128K context", efforts: ["low"] },
			{ id: "vendor/mystery", description: "no hints at all", efforts: null },
			{ id: "xiaomi/mimo-v2.6-pro", description: "flagship", efforts: [] },
			{ id: "deepseek/deepseek-v4.1-flash", description: "V4.1", efforts: null },
		],
	};

	test("maps efforts and context hints", () => {
		const specs = specsFromSnapshot(snap, () => true);
		const by = Object.fromEntries(specs.map((s) => [s.id, s]));
		expect(by["vendor/tiny-model"]).toMatchObject({ efforts: ["low"], contextWindow: 128_000 });
		expect(by["z-ai/glm-5.3-flash"]!.efforts).toEqual(["low", "high", "max"]);
		expect(by["xiaomi/mimo-v2.6-pro"]!.efforts).toEqual([]);
	});

	test("unknown efforts fall back to the built-in table, else to no effort", () => {
		const by = Object.fromEntries(specsFromSnapshot(snap, () => true).map((s) => [s.id, s]));
		expect(by["deepseek/deepseek-v4.1-flash"]!.efforts).toEqual(["off", "low", "high", "max"]);
		expect(by["vendor/mystery"]!.efforts).toEqual([]);
	});

	test("models without a context hint keep the 1M default", () => {
		const by = Object.fromEntries(specsFromSnapshot(snap, () => true).map((s) => [s.id, s]));
		expect(by["vendor/mystery"]!.contextWindow ?? 1_000_000).toBe(1_000_000);
	});

	test("the filter drops models", () => {
		const specs = specsFromSnapshot(snap, compileFilter("vendor/*"));
		expect(specs.map((s) => s.id)).toEqual(["vendor/tiny-model", "vendor/mystery"]);
	});
});

describe("loadModelSpecs", () => {
	test("no cache: discovers, writes the cache and returns the dynamic models", async () => {
		const box = catalogBox();
		const specs = await loadModelSpecs({ env: box.env });
		expect(specs.map((s) => s.id)).toContain("zai-org/glm-5.3");
		expect(specs.length).toBe(6);
		const cached = readSnapshot(box.cache)!;
		expect(cached.models.length).toBe(6);
		expect(calls(box).filter((c) => c.kind === "list").length).toBe(1);
	});

	test("no cache and cmd unavailable: falls back to the built-in table", async () => {
		const box = catalogBox({ CMDCODE_BRIDGE_BIN: "/nonexistent/cmd" });
		const specs = await loadModelSpecs({ env: box.env });
		expect(specs.map((s) => s.id)).toEqual(FALLBACK_MODELS.map((m) => m.id));
		expect(existsSync(box.cache)).toBe(false);
	});

	test("fresh cache: no cmd call at all", async () => {
		const box = catalogBox();
		await loadModelSpecs({ env: box.env });
		writeFileSync(box.log, "");
		const specs = await loadModelSpecs({ env: box.env });
		expect(specs.length).toBe(6);
		expect(calls(box)).toEqual([]);
	});

	test("stale cache: answers immediately from the cache and refreshes in the background", async () => {
		const box = catalogBox();
		const old: CatalogSnapshot = {
			version: 1,
			savedAt: Date.now() - 48 * HOUR,
			models: [{ id: "old/model", description: "old", efforts: [] }],
		};
		writeSnapshot(box.cache, old);
		const specs = await loadModelSpecs({ env: box.env });
		expect(specs.map((s) => s.id)).toEqual(["old/model"]);
		const refreshed = await waitFor(() => {
			const s = readSnapshot(box.cache);
			return s && s.models.length === 6 ? s : null;
		}, 15_000);
		expect(refreshed).not.toBeNull();
	});

	test("a second background refresh is skipped while a lock is held", async () => {
		const box = catalogBox();
		writeSnapshot(box.cache, { version: 1, savedAt: 1, models: [{ id: "old/model", description: "", efforts: [] }] });
		writeFileSync(`${box.cache}.lock`, String(process.pid));
		await loadModelSpecs({ env: box.env });
		await Bun.sleep(300);
		expect(calls(box)).toEqual([]);
	});

	test("an expired lock does not block the refresh", async () => {
		const box = catalogBox();
		writeSnapshot(box.cache, { version: 1, savedAt: 1, models: [{ id: "old/model", description: "", efforts: [] }] });
		const lock = `${box.cache}.lock`;
		writeFileSync(lock, "999999");
		const past = new Date(Date.now() - 10 * 60_000);
		utimesSync(lock, past, past);
		await loadModelSpecs({ env: box.env });
		const refreshed = await waitFor(() => (readSnapshot(box.cache)?.models.length === 6 ? true : null), 15_000);
		expect(refreshed).toBe(true);
		expect(existsSync(lock)).toBe(false);
	});

	test("CMDCODE_BRIDGE_REFRESH=1 forces a blocking refresh even with a fresh cache", async () => {
		const box = catalogBox();
		writeSnapshot(box.cache, { version: 1, savedAt: Date.now(), models: [{ id: "old/model", description: "", efforts: [] }] });
		const specs = await loadModelSpecs({ env: { ...box.env, CMDCODE_BRIDGE_REFRESH: "1" } });
		expect(specs.length).toBe(6);
	});

	test("a failed forced refresh keeps serving the cached models", async () => {
		const box = catalogBox({ CMD_STUB_LIST_FAIL: "1", CMDCODE_BRIDGE_REFRESH: "1" });
		writeSnapshot(box.cache, { version: 1, savedAt: Date.now(), models: [{ id: "old/model", description: "", efforts: [] }] });
		const specs = await loadModelSpecs({ env: box.env });
		expect(specs.map((s) => s.id)).toEqual(["old/model"]);
	});

	test("CMDCODE_BRIDGE_MODELS filters the result", async () => {
		const box = catalogBox({ CMDCODE_BRIDGE_MODELS: "gpt-6-luna,z-ai/*" });
		const specs = await loadModelSpecs({ env: box.env });
		expect(specs.map((s) => s.id).sort()).toEqual(["gpt-6-luna", "z-ai/glm-5.3-flash"]);
	});

	test("CMDCODE_BRIDGE_CACHE_TTL_HOURS changes what counts as fresh", async () => {
		const box = catalogBox({ CMDCODE_BRIDGE_CACHE_TTL_HOURS: "1" });
		writeSnapshot(box.cache, {
			version: 1,
			savedAt: Date.now() - 2 * HOUR,
			models: [{ id: "old/model", description: "", efforts: [] }],
		});
		await loadModelSpecs({ env: box.env });
		const refreshed = await waitFor(() => (readSnapshot(box.cache)?.models.length === 6 ? true : null), 15_000);
		expect(refreshed).toBe(true);
	});
});

function readRealpath(p: string): string {
	return require("node:fs").realpathSync(p);
}
