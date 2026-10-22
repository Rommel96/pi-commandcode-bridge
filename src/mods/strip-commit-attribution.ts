// Loaded by `cmd --mod` (via jiti), so this file must not import anything.
// cmd's system prompt tells the model to end every git commit message with this
// exact trailer; remove it from tool inputs before the tool runs. Other
// Co-authored-by trailers are left alone.
const TRAILER = /\r?\n?[ \t]*Co-authored-by: CommandCodeBot <noreply@commandcode\.ai>[ \t]*/g;

function strip(value: any): any {
	if (typeof value === "string") return value.replace(TRAILER, "");
	if (Array.isArray(value)) return value.map(strip);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, strip(item)]));
	}
	return value;
}

export default function (cmd: any): void {
	cmd.hooks({
		beforeToolCall({ input }: { input: unknown }) {
			const next = strip(input);
			return JSON.stringify(next) === JSON.stringify(input) ? undefined : { input: next };
		},
	});
}
