import { test, expect } from "bun:test";
import { setActiveSpecs, toCmdEffort } from "../src/models.js";
import {
	flagValue,
	resultLine,
	runStart,
	runTurn,
	sandbox,
	setScenario,
	stubEnv,
	testModel,
	userMsg,
	waitForRecord,
} from "./helpers.js";

const DEEPSEEK = ["off", "low", "high", "max"] as const;
const LUNA = ["low", "medium", "high", "xhigh", "max"] as const;
const GLM_FLASH = ["low", "high", "max"] as const;
const MIMO = [] as const;

test("effort clamping for GLM-5.3 Flash (low, high, max)", () => {
	expect(toCmdEffort("off", GLM_FLASH)).toBe("low");
	expect(toCmdEffort("minimal", GLM_FLASH)).toBe("low");
	expect(toCmdEffort("low", GLM_FLASH)).toBe("low");
	expect(toCmdEffort("medium", GLM_FLASH)).toBe("high");
	expect(toCmdEffort("high", GLM_FLASH)).toBe("high");
	expect(toCmdEffort("xhigh", GLM_FLASH)).toBe("max");
	expect(toCmdEffort("max", GLM_FLASH)).toBe("max");
	expect(toCmdEffort(undefined, GLM_FLASH)).toBeUndefined();
});

test("effort clamping for DeepSeek (off, low, high, max)", () => {
	expect(toCmdEffort("off", DEEPSEEK)).toBe("off");
	expect(toCmdEffort("minimal", DEEPSEEK)).toBe("low");
	expect(toCmdEffort("low", DEEPSEEK)).toBe("low");
	expect(toCmdEffort("medium", DEEPSEEK)).toBe("high");
	expect(toCmdEffort("high", DEEPSEEK)).toBe("high");
	expect(toCmdEffort("xhigh", DEEPSEEK)).toBe("max");
	expect(toCmdEffort("max", DEEPSEEK)).toBe("max");
	expect(toCmdEffort(undefined, DEEPSEEK)).toBeUndefined();
});

test("effort clamping for Luna (low, medium, high, xhigh, max)", () => {
	expect(toCmdEffort("off", LUNA)).toBe("low");
	expect(toCmdEffort("minimal", LUNA)).toBe("low");
	expect(toCmdEffort("low", LUNA)).toBe("low");
	expect(toCmdEffort("medium", LUNA)).toBe("medium");
	expect(toCmdEffort("high", LUNA)).toBe("high");
	expect(toCmdEffort("xhigh", LUNA)).toBe("xhigh");
	expect(toCmdEffort("max", LUNA)).toBe("max");
	expect(toCmdEffort(undefined, LUNA)).toBeUndefined();
});

test("MiMo has no effort list: never maps to an effort", () => {
	expect(toCmdEffort("max", MIMO)).toBeUndefined();
	expect(toCmdEffort("low", MIMO)).toBeUndefined();
	expect(toCmdEffort(undefined, MIMO)).toBeUndefined();
});

async function effortArgv(
	modelId: string,
	reasoning: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined,
): Promise<string[]> {
	const sb = sandbox();
	setScenario(sb, {
		script: [{ emit: runStart("S1") }, { emit: resultLine("S1", "ok") }],
	});
	await runTurn(testModel(modelId), "S", [userMsg("q")], {
		env: stubEnv(sb),
		sessionId: `effort-${modelId}-${reasoning ?? "none"}`,
		...(reasoning ? { reasoning } : {}),
	});
	return (await waitForRecord(sb)).argv;
}

test("argv: DeepSeek reasoning xhigh sends --effort max", async () => {
	const argv = await effortArgv("deepseek/deepseek-v4.1-flash", "xhigh");
	expect(flagValue(argv, "--effort")).toBe("max");
});

test("argv: Luna reasoning medium sends --effort medium", async () => {
	const argv = await effortArgv("gpt-6-luna", "medium");
	expect(flagValue(argv, "--effort")).toBe("medium");
});

test("argv: GLM-5.3 Flash reasoning xhigh sends --effort max (cmd rejects xhigh)", async () => {
	const argv = await effortArgv("z-ai/glm-5.3-flash", "xhigh");
	expect(flagValue(argv, "--effort")).toBe("max");
});

test("argv: MiMo never gets --effort, even when a level is requested", async () => {
	const argv = await effortArgv("xiaomi/mimo-v2.6-pro", "max");
	expect(argv).not.toContain("--effort");
});

test("argv: no --effort when no level was requested", async () => {
	const argv = await effortArgv("deepseek/deepseek-v4.1-flash", undefined);
	expect(argv).not.toContain("--effort");
});

test("argv: efforts of a model discovered at runtime drive the clamping", async () => {
	setActiveSpecs([{ id: "xai/grok-4.7", name: "xai/grok-4.7", efforts: ["low", "medium", "high", "xhigh"] }]);
	try {
		const high = await effortArgv("xai/grok-4.7", "max");
		expect(flagValue(high, "--effort")).toBe("xhigh");
		const none = await effortArgv("unlisted/model", "high");
		expect(none).not.toContain("--effort");
	} finally {
		setActiveSpecs(undefined);
	}
});
