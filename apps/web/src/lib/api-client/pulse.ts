import type { PulseResponse } from "@arr/shared";
import { apiRequest } from "./base";

export interface FetchPulseParams {
	attentionOnly?: boolean;
}

export async function fetchPulse(params: FetchPulseParams = {}): Promise<PulseResponse> {
	const path = params.attentionOnly ? "/api/pulse?attentionOnly=true" : "/api/pulse";
	return apiRequest<PulseResponse>(path);
}
