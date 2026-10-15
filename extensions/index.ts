import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadModelSpecs } from "../src/catalog.js";
import { BASE_URL, CUSTOM_API_ID, PROVIDER_ID, setActiveSpecs, toPiModels } from "../src/models.js";
import { streamSimple } from "../src/provider.js";

/**
 * Register the `commandcode` provider backed by the Command Code CLI. The model
 * list comes from `cmd --list-models` (cached), with a built-in table as fallback.
 */
export default async function registerCommandCodeProvider(
	pi: ExtensionAPI,
	env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
	const specs = await loadModelSpecs({ env });
	if (specs.length === 0) return;
	setActiveSpecs(specs);
	pi.registerProvider(PROVIDER_ID, {
		name: "Command Code (cmd)",
		baseUrl: BASE_URL,
		apiKey: "not-used",
		api: CUSTOM_API_ID,
		models: toPiModels(specs),
		streamSimple,
	});
}
