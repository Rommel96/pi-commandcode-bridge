/** The Command Code CLI is `cmd`; on Windows that name is the system shell, so the CLI is `cmdc`. */
export function defaultCmdBin(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "cmdc" : "cmd";
}

/** `CMDCODE_BRIDGE_BIN` when set, else the platform default. */
export function resolveBin(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
	return env.CMDCODE_BRIDGE_BIN || defaultCmdBin(platform);
}
