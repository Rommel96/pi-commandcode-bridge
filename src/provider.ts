import type {
	Api,
	AssistantMessageEventStream,
	Model,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";

/** The provider request payload passed to `options.onPayload` (spec R6). */
export interface CmdPayload {
	/** Full child argv, including the prompt. */
	argv: string[];
	/** The prompt sent to `cmd`. */
	prompt: string;
}

/** Custom `streamSimple` driving one `cmd -p` run per Pi request (spec R4-R6). */
export function streamSimple(
	_model: Model<Api>,
	_context: TranscriptContext,
	_options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	throw new Error("not implemented");
}
