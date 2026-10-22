import { fileURLToPath } from "node:url";

/**
 * Absolute path of the mod that strips cmd's injected commit trailer. Resolved
 * like `shimPath()` so it works from source and from the installed package.
 */
export function attributionModPath(): string {
	return fileURLToPath(new URL("./mods/strip-commit-attribution.ts", import.meta.url));
}

/** `--mod` args for every run; CMDCODE_BRIDGE_COMMIT_ATTRIBUTION=keep opts out. */
export function attributionArgs(env: Record<string, string | undefined>): string[] {
	return env.CMDCODE_BRIDGE_COMMIT_ATTRIBUTION === "keep" ? [] : ["--mod", attributionModPath()];
}
