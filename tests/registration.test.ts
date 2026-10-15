import { afterEach, test, expect } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import registerCommandCodeProvider from "../extensions/index.js";
import { setActiveSpecs } from "../src/models.js";
import { sandbox } from "./helpers.js";

afterEach(() => setActiveSpecs(undefined));

const FIXTURES = path.join(import.meta.dir, "fixtures");

/** Env that makes discovery impossible (no cmd, empty cache): the built-in table applies. */
function offlineEnv(): Record<string, string> {
	const sb = sandbox();
	return {
		CMDCODE_BRIDGE_BIN: "/nonexistent/cmd",
		CMDCODE_BRIDGE_CACHE: path.join(sb.dir, "cache", "models.json"),
	};
}

function fakePi() {
	const calls: Array<{ name: string; config: Record<string, any> }> = [];
	return {
		calls,
		pi: {
			registerProvider(name: string, config: Record<string, any>) {
				calls.push({ name, config });
			},
		},
	};
}

const EXPECTED_IDS = [
	"deepseek/deepseek-v4.1-flash",
	"xiaomi/mimo-v2.6-pro",
	"gpt-6-luna",
	"z-ai/glm-5.3-flash",
];

test("without discovery the extension registers the built-in four models (item 11)", async () => {
	const { calls, pi } = fakePi();

	await registerCommandCodeProvider(pi as never, offlineEnv());

	expect(calls.length).toBe(1);
	expect(calls[0]!.name).toBe("commandcode");
	const config = calls[0]!.config;
	expect(config.api).toBe("commandcode-cli");
	expect(typeof config.streamSimple).toBe("function");
	expect(typeof config.baseUrl).toBe("string");
	expect(config.baseUrl.length).toBeGreaterThan(0);

	const models: Array<Record<string, any>> = config.models ?? [];
	expect(models.map((m) => m.id)).toEqual(EXPECTED_IDS);
	for (const m of models) {
		expect(m.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(m.contextWindow).toBe(1_000_000);
		expect(m.maxTokens).toBeGreaterThan(0);
	}

	const deepseek = models.find((m) => m.id === "deepseek/deepseek-v4.1-flash")!;
	expect(deepseek.reasoning).toBe(true);
	expect(deepseek.thinkingLevelMap).toEqual({
		off: "off",
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});

	const luna = models.find((m) => m.id === "gpt-6-luna")!;
	expect(luna.reasoning).toBe(true);
	expect(luna.thinkingLevelMap).toEqual({
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	});

	const mimo = models.find((m) => m.id === "xiaomi/mimo-v2.6-pro")!;
	expect(mimo.reasoning).toBe(false);
	expect(mimo.thinkingLevelMap).toBeUndefined();

	const glm = models.find((m) => m.id === "z-ai/glm-5.3-flash")!;
	expect(glm.reasoning).toBe(true);
	expect(glm.thinkingLevelMap).toEqual({
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
});

test("the registered models come from the live cmd catalog", async () => {
	const sb = sandbox();
	const { calls, pi } = fakePi();
	await registerCommandCodeProvider(pi as never, {
		CMDCODE_BRIDGE_BIN: path.join(FIXTURES, "cmd-catalog"),
		CMDCODE_BRIDGE_CACHE: path.join(sb.dir, "cache", "models.json"),
		CMD_STUB_LIST: path.join(FIXTURES, "list-small.txt"),
		CMD_STUB_PROBES: path.join(FIXTURES, "probes-small.json"),
	});

	expect(calls.length).toBe(1);
	const models: Array<Record<string, any>> = calls[0]!.config.models;
	expect(models.map((m) => m.id)).toEqual([
		"deepseek/deepseek-v4.1-flash",
		"xiaomi/mimo-v2.6-pro",
		"z-ai/glm-5.3-flash",
		"zai-org/glm-5.3",
		"vendor/tiny-model",
		"gpt-6-luna",
	]);
	const tiny = models.find((m) => m.id === "vendor/tiny-model")!;
	expect(tiny.contextWindow).toBe(128_000);
	expect(tiny.reasoning).toBe(false);
	const glm = models.find((m) => m.id === "z-ai/glm-5.3-flash")!;
	expect(glm.thinkingLevelMap).toEqual({
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
});

test("nothing is registered when the filter removes every model", async () => {
	const { calls, pi } = fakePi();
	await registerCommandCodeProvider(pi as never, { ...offlineEnv(), CMDCODE_BRIDGE_MODELS: "no-such/*" });
	expect(calls.length).toBe(0);
});
