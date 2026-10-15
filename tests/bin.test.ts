import { expect, test } from "bun:test";
import { defaultCmdBin, resolveBin } from "../src/bin.js";

test("the Command Code CLI is `cmd`, except on Windows where `cmd` is the system shell", () => {
	expect(defaultCmdBin("darwin")).toBe("cmd");
	expect(defaultCmdBin("linux")).toBe("cmd");
	expect(defaultCmdBin("win32")).toBe("cmdc");
});

test("CMDCODE_BRIDGE_BIN overrides the default", () => {
	expect(resolveBin({ CMDCODE_BRIDGE_BIN: "/opt/cmd" }, "win32")).toBe("/opt/cmd");
	expect(resolveBin({}, "win32")).toBe("cmdc");
	expect(resolveBin({ CMDCODE_BRIDGE_BIN: "" }, "linux")).toBe("cmd");
});
