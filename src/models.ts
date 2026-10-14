import type { Api, Model, ModelThinkingLevel, ThinkingLevelMap } from "@earendil-works/pi-ai";

/** Effort values `cmd --effort` accepts, across the supported models. */
export type CmdEffort = "off" | "low" | "medium" | "high" | "xhigh" | "max";

/** One row of the static model table (spec R2). */
export interface CmdModelSpec {
	/** Pi model id; slashes are kept (e.g. "deepseek/deepseek-v4.1-flash"). */
	id: string;
	name: string;
	/** Supported `cmd --effort` values; empty means `--effort` must never be passed. */
	efforts: readonly CmdEffort[];
}

/** Custom API id: no built-in provider claims it, so it can never collide. */
export const CUSTOM_API_ID = "commandcode-cli";
export const PROVIDER_ID = "commandcode";
/** Required by registration and unused: `streamSimple` intercepts every request. */
export const BASE_URL = "commandcode-cli://commandcode";
export const CONTEXT_WINDOW = 1_000_000;
export const MAX_TOKENS = 65_536;

/** Static table of supported Command Code models (spec R2). */
export const CMD_MODELS: readonly CmdModelSpec[] = [
	{
		id: "deepseek/deepseek-v4.1-flash",
		name: "deepseek/deepseek-v4.1-flash",
		efforts: ["off", "low", "high", "max"],
	},
	{
		id: "xiaomi/mimo-v2.6-pro",
		name: "xiaomi/mimo-v2.6-pro",
		efforts: [],
	},
	{
		id: "gpt-6-luna",
		name: "gpt-6-luna",
		efforts: ["low", "medium", "high", "xhigh", "max"],
	},
];

/** Pi thinking levels in ascending order; cmd efforts use the same vocabulary. */
const LEVEL_ORDER: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Map a Pi thinking level to a supported `cmd` effort, clamping to the nearest
 * supported level (spec R3). Ties round up: `medium` on DeepSeek -> `high`,
 * `minimal` on DeepSeek -> `low`. Undefined when no level was requested or the
 * model has no effort list, so `--effort` is omitted entirely.
 */
export function toCmdEffort(
	level: ModelThinkingLevel | undefined,
	efforts: readonly CmdEffort[],
): CmdEffort | undefined {
	if (!level || efforts.length === 0) return undefined;
	const supported = efforts as readonly string[];
	if (supported.includes(level)) return level as CmdEffort;
	const i = LEVEL_ORDER.indexOf(level);
	if (i < 0) return undefined;
	for (let j = i + 1; j < LEVEL_ORDER.length; j++) {
		const candidate = LEVEL_ORDER[j] as string;
		if (supported.includes(candidate)) return candidate as CmdEffort;
	}
	for (let j = i - 1; j >= 0; j--) {
		const candidate = LEVEL_ORDER[j] as string;
		if (supported.includes(candidate)) return candidate as CmdEffort;
	}
	return undefined;
}

/**
 * Build the thinkingLevelMap for a model: a Pi level is supported exactly when
 * its name is one of the model's cmd efforts; every other level is hidden with
 * null (spec R2). Hidden levels still clamp when requested (spec R3). Models
 * without efforts (MiMo) get no map at all.
 */
export function thinkingLevelMapFor(efforts: readonly CmdEffort[]): ThinkingLevelMap | undefined {
	if (efforts.length === 0) return undefined;
	const supported = efforts as readonly string[];
	const map: Record<string, string | null> = {};
	for (const level of LEVEL_ORDER) {
		map[level] = supported.includes(level) ? level : null;
	}
	return map as ThinkingLevelMap;
}

/** Project one table row to Pi's Model shape (spec R2). */
export function toPiModel(spec: CmdModelSpec): Model<Api> {
	const thinkingLevelMap = thinkingLevelMapFor(spec.efforts);
	return {
		id: spec.id,
		name: spec.name,
		api: CUSTOM_API_ID as Api,
		provider: PROVIDER_ID,
		baseUrl: BASE_URL,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: spec.efforts.length > 0,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		contextWindow: CONTEXT_WINDOW,
		maxTokens: MAX_TOKENS,
	};
}

/** Project the whole static table to Pi models. */
export function toPiModels(): Model<Api>[] {
	return CMD_MODELS.map(toPiModel);
}
