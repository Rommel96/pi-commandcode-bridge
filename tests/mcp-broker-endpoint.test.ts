import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { brokerEndpoint, openBroker, startBroker } from "../src/mcp/broker.js";

const TOOLS = [{ name: "read", description: "", parameters: {} }] as any;

const dirs: string[] = [];
function sandboxDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "picc-endpoint-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("broker endpoint is a named pipe on win32 and a broker.sock file elsewhere", () => {
	const dir = sandboxDir();
	const pipe = brokerEndpoint(dir, "win32");
	expect(pipe).toMatch(/^\\\\\.\\pipe\\pi-cmd-bridge-[0-9a-f]+$/);
	expect(brokerEndpoint(dir, "win32")).not.toBe(pipe);
	for (const platform of ["linux", "darwin", "freebsd"] as NodeJS.Platform[]) {
		expect(brokerEndpoint(dir, platform)).toBe(path.join(dir, "broker.sock"));
	}
});

test("openBroker rejects and cleans up when the endpoint cannot be listened on", async () => {
	const missing = path.join(sandboxDir(), "no-such-directory", "broker.sock");
	let broker: Awaited<ReturnType<typeof openBroker>> | undefined;
	let caught: NodeJS.ErrnoException | undefined;
	try {
		broker = await openBroker({ tools: TOOLS, endpoint: missing });
	} catch (error) {
		caught = error as NodeJS.ErrnoException;
	}
	expect(broker).toBeUndefined();
	expect(caught).toBeDefined();
	expect(caught!.code).toBe("ENOENT");
});

test("a broker whose listen fails rejects ready and the process keeps serving", async () => {
	const dir = sandboxDir();
	const broken = startBroker({ tools: TOOLS, endpoint: path.join(dir, "missing", "broker.sock") });
	await expect(broken.ready).rejects.toThrow();
	broken.close();

	const healthy = startBroker({ tools: TOOLS });
	try {
		await healthy.ready;
		expect(healthy.pending).toHaveLength(0);
	} finally {
		healthy.close();
	}
});
