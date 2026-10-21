/**
 * Correlation between parked MCP calls and the Pi tool results that answer them.
 *
 * Pi returns one `toolResult` per emitted `toolCall`, carrying the exact id the
 * bridge generated. That id is the only safe key: several calls of the same tool
 * (for example three parallel `subagent_run`) share a name, so matching by name
 * would hand the first result to every call.
 */
import type { BrokerCall } from "./broker.js";

/** Minimal shape shared by Pi's ToolResultMessage and test doubles. */
export interface ToolResultRef {
	toolCallId: string;
	toolName: string;
}

/**
 * Match a parked call to its result.
 *
 * The name fallback exists only for legacy results whose id does not match, and
 * only when there is exactly one pending call with that name. With several
 * same-name calls it returns undefined instead of guessing.
 */
export function matchToolResult<T extends ToolResultRef>(
	call: Pick<BrokerCall, "id" | "name">,
	pending: readonly Pick<BrokerCall, "id" | "name">[],
	toolResults: readonly T[],
): T | undefined {
	const exact = toolResults.find((result) => result.toolCallId === call.id);
	if (exact) return exact;

	const sameNameCalls = pending.filter((candidate) => candidate.name === call.name);
	if (sameNameCalls.length !== 1) return undefined;

	const sameNameResults = toolResults.filter((result) => result.toolName === call.name);
	return sameNameResults.length === 1 ? sameNameResults[0] : undefined;
}
