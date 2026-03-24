import type { PulseResponse } from "@arr/shared";
import { apiRequest } from "./base";

export async function fetchPulse(): Promise<PulseResponse> {
	return apiRequest<PulseResponse>("/api/pulse");
}
