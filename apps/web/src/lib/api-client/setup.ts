import { setupDiscoveryResponseSchema, type SetupDiscoveryResponse } from "@arr/shared";
import { apiRequest } from "./base";

export async function discoverSetupCandidates(): Promise<SetupDiscoveryResponse> {
	const response = await apiRequest<SetupDiscoveryResponse>("/api/setup/discovery", {
		method: "POST",
	});
	return setupDiscoveryResponseSchema.parse(response);
}
