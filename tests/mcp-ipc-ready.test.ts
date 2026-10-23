import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startIpcServer } from "../src/mcp/ipc.js";

const dirs: string[] = [];
function sandboxDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "picc-ipc-ready-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const handler = () => ({ content: [{ type: "text", text: "unused" }] });

test("ipc readiness rejects on a listen failure instead of crashing the process", async () => {
	const dir = sandboxDir();
	const bad = path.join(dir, "missing-directory", "broker.sock");
	const server = startIpcServer(bad, handler);
	let caught: NodeJS.ErrnoException | undefined;
	try {
		await server.ready;
	} catch (error) {
		caught = error as NodeJS.ErrnoException;
	}
	expect(caught).toBeDefined();
	expect(caught!.code).toBe("ENOENT");
	server.close();

	// The process is still healthy: a later server binds and becomes ready.
	const ok = startIpcServer(path.join(dir, "ok.sock"), handler);
	await ok.ready;
	ok.close();
});

test("ipc readiness resolves once the endpoint is accepting connections", async () => {
	const dir = sandboxDir();
	const server = startIpcServer(path.join(dir, "ready.sock"), handler);
	try {
		await server.ready;
	} finally {
		server.close();
	}
});
