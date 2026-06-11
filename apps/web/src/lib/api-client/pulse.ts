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
	return apiRequest<PulseActionResponse>(`/api/pulse/${encodeURIComponent(signalId)}/action`, {
		json: action,
	});
}

// ---------------------------------------------------------------------------
// Dismiss-until-recovery
// ---------------------------------------------------------------------------
//
// Dismissing tombstones a signal until it stops firing (the backend sweeps
// the tombstone once the signal recovers, so a recurrence resurfaces).
// Critical signals are never suppressed — the backend filter enforces this
// at read time regardless of what the client sends.

/** Hide a non-critical signal until it recovers. */
export async function dismissPulseSignal(signalId: string): Promise<PulseActionResponse> {
	return apiRequest<PulseActionResponse>(`/api/pulse/${encodeURIComponent(signalId)}/dismiss`, {
		method: "POST",
	});
}

/** Undo a single dismissal (toast "Undo" path). No-op if already swept. */
export async function restorePulseSignal(signalId: string): Promise<PulseActionResponse> {
	return apiRequest<PulseActionResponse>(`/api/pulse/${encodeURIComponent(signalId)}/dismiss`, {
		method: "DELETE",
	});
}

export interface RestoreAllDismissalsResponse {
	status: "ok";
	cleared: number;
}

/** Clear every dismissal tombstone for the current user. */
export async function restoreAllPulseDismissals(): Promise<RestoreAllDismissalsResponse> {
	return apiRequest<RestoreAllDismissalsResponse>("/api/pulse/dismissals", {
		method: "DELETE",
	});
}
