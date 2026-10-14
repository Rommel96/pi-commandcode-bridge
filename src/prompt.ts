import type { Message } from "@earendil-works/pi-ai";

/** Prompt for the first `cmd` run of a conversation: system prompt, prior transcript, latest user message (spec R5). */
export function buildInitialPrompt(
	_systemPrompt: string,
	_prior: readonly Message[],
	_latestUserText: string,
): string {
	throw new Error("not implemented");
}

/** Prompt for later runs: only messages added since the last assistant message (spec R5). */
export function buildDeltaPrompt(_messages: readonly Message[]): string {
	throw new Error("not implemented");
}
