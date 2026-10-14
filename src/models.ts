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

/** Map a Pi thinking level to a supported `cmd` effort, clamping to the nearest supported level (spec R3). */
export function toCmdEffort(
	_level: ModelThinkingLevel | undefined,
	_efforts: readonly CmdEffort[],
): CmdEffort | undefined {
	throw new Error("not implemented");
}

/** Build the thinkingLevelMap for a model: unsupported Pi levels hidden with null (spec R2). */
export function thinkingLevelMapFor(_efforts: readonly CmdEffort[]): ThinkingLevelMap | undefined {
	throw new Error("not implemented");
}

/** Project one table row to Pi's Model shape (spec R2). */
export function toPiModel(_spec: CmdModelSpec): Model<Api> {
	throw new Error("not implemented");
}

/** Project the whole static table to Pi models. */
export function toPiModels(): Model<Api>[] {
	throw new Error("not implemented");
}
