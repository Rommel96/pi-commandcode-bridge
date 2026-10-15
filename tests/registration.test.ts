import { test, expect } from "bun:test";
import registerCommandCodeProvider from "../extensions/index.js";

const EXPECTED_IDS = [
	"deepseek/deepseek-v4.1-flash",
	"xiaomi/mimo-v2.6-pro",
	"gpt-6-luna",
	"z-ai/glm-5.3-flash",
];

test("the extension registers provider commandcode with the four models (item 11)", () => {
	const calls: Array<{ name: string; config: Record<string, any> }> = [];
	const fakePi = {
		registerProvider(name: string, config: Record<string, any>) {
			calls.push({ name, config });
		},
	};

	registerCommandCodeProvider(fakePi as never);

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
