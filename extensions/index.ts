import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BASE_URL, CUSTOM_API_ID, PROVIDER_ID, toPiModels } from "../src/models.js";
import { streamSimple } from "../src/provider.js";

/** Register the `commandcode` provider backed by the Command Code CLI (spec R1). */
export default function registerCommandCodeProvider(pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "Command Code (cmd)",
		baseUrl: BASE_URL,
		apiKey: "not-used",
		api: CUSTOM_API_ID,
		models: toPiModels(),
		streamSimple,
	});
}
