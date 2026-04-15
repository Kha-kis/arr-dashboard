import type { PulseAction, PulseResponse } from "@arr/shared";
import { apiRequest } from "./base";

export interface FetchPulseParams {
	attentionOnly?: boolean;
}

export async function fetchPulse(params: FetchPulseParams = {}): Promise<PulseResponse> {
	const path = params.attentionOnly ? "/api/pulse?attentionOnly=true" : "/api/pulse";
	return apiRequest<PulseResponse>(path);
}

export interface PulseActionResponse {
	status: "ok";
	detail?: string;
}

/**
 * Dispatch an operator action for a Pulse signal.
 *
 * The signal id lives in the URL (for audit/logging context); the action
 * envelope is the body. The backend validates both and returns the
 * dispatcher result on 200, or a 4xx with an error message the caller
 * should toast.
 */
export async function dispatchPulseAction(
	signalId: string,
	action: PulseAction,
): Promise<PulseActionResponse> {
	return apiRequest<PulseActionResponse>(
		`/api/pulse/${encodeURIComponent(signalId)}/action`,
		{ json: action },
	);
}
