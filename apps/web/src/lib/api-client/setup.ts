import {
	type ApplySetupStartersRequest,
	type ApplySetupStartersResponse,
	applySetupStartersResponseSchema,
	type SetupDiscoveryResponse,
	type SetupStarterPreviewResponse,
	setupDiscoveryResponseSchema,
	setupStarterPreviewResponseSchema,
} from "@arr/shared";
import { apiRequest } from "./base";

export async function discoverSetupCandidates(): Promise<SetupDiscoveryResponse> {
	const response = await apiRequest<SetupDiscoveryResponse>("/api/setup/discovery", {
		method: "POST",
	});
	return setupDiscoveryResponseSchema.parse(response);
}

export async function fetchSetupStarters(): Promise<SetupStarterPreviewResponse> {
	const response = await apiRequest<SetupStarterPreviewResponse>("/api/setup/starters");
	return setupStarterPreviewResponseSchema.parse(response);
}

export async function applySetupStarters(
	payload: ApplySetupStartersRequest,
): Promise<ApplySetupStartersResponse> {
	const response = await apiRequest<ApplySetupStartersResponse>("/api/setup/starters", {
		method: "POST",
		json: payload,
	});
	return applySetupStartersResponseSchema.parse(response);
}
