import type { Message } from "@earendil-works/pi-ai";

const SYSTEM_PREAMBLE =
	"[System prompt of the pi session that spawned this run. Apply it for the whole conversation.]";
const TRANSCRIPT_HEADER = "[Conversation transcript]";
const LATEST_HEADER = "[User message]";
const DELTA_HEADER = "[New messages since the last assistant turn]";

/** Flatten a message to its plain text: text blocks only (spec R5). */
export function messageText(message: Message): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => (b as { type?: string }).type === "text")
		.map((b) => b.text)
		.join("\n");
}

/** Render one message as a plain-text transcript entry, or null to skip it. */
function renderMessage(message: Message): string | null {
	if (message.role === "user") {
		const text = messageText(message).trim();
		return text ? `[user]\n${text}` : null;
	}
	if (message.role === "assistant") {
		const text = messageText(message).trim();
		return text ? `[assistant]\n${text}` : null;
	}
	if (message.role === "toolResult") {
		const text = messageText(message).trim() || "(no text output)";
		return `[tool result: ${message.toolName}${message.isError ? " (error)" : ""}]\n${text}`;
	}
	return null;
}

/**
 * Prompt for the first `cmd` run of a conversation: the Pi system prompt, a
 * plain-text transcript of the prior messages, then the latest user message
 * (spec R5).
 */
export function buildInitialPrompt(
	systemPrompt: string,
	prior: readonly Message[],
	latestUserText: string,
): string {
	const parts: string[] = [];
	if (systemPrompt.trim()) parts.push(`${SYSTEM_PREAMBLE}\n\n${systemPrompt}`);
	const transcript = prior
		.map(renderMessage)
		.filter((s): s is string => s !== null);
	if (transcript.length > 0) parts.push(`${TRANSCRIPT_HEADER}\n${transcript.join("\n\n")}`);
	if (latestUserText.trim()) parts.push(`${LATEST_HEADER}\n${latestUserText}`);
	return parts.join("\n\n");
}

/**
 * Prompt for later runs: only the messages added since the last assistant
 * message (user text and tool-result text) (spec R5).
 */
export function buildDeltaPrompt(messages: readonly Message[]): string {
	let start = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			start = i + 1;
			break;
		}
	}
	const parts = messages
		.slice(start)
		.map(renderMessage)
		.filter((s): s is string => s !== null);
	if (parts.length === 0) return "";
	return `${DELTA_HEADER}\n${parts.join("\n\n")}`;
}
