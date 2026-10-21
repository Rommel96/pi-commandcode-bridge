import { afterAll } from "bun:test";
import { removeSandboxes } from "./helpers.js";

// Global hook: a top-level afterAll in an imported helper never runs.
afterAll(removeSandboxes);
