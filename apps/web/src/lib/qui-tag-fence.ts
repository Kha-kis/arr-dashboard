import type { QueryClient } from "@tanstack/react-query";
import { quiKeys } from "./query-keys";

export interface QuiTagTarget {
	quiInstanceId: string | null;
	qbitInstanceId: number | null;
	hash: string;
}

export interface QuiTagFence {
	attemptId: string;
	status: "pending" | "acknowledged" | "unconfirmed";
}

export type QuiTagFences = Record<string, QuiTagFence>;

export const quiTagTargetKey = (target: QuiTagTarget): string =>
	JSON.stringify([target.quiInstanceId, target.qbitInstanceId, target.hash.toLowerCase()]);

// One in-memory cache entry survives observer unmount. It contains unresolved
// targets only; a verified post-attempt observation removes its target entry.
// This is a UI stale-baseline fence, not server mutation/ownership authority.
export function beginQuiTagAttempt(queryClient: QueryClient, target: QuiTagTarget) {
	const targetKey = quiTagTargetKey(target);
	if (queryClient.getQueryData<QuiTagFences>(quiKeys.tagFences)?.[targetKey]) {
		throw new Error("Refresh torrent data before another tag change.");
	}
	queryClient.setQueryDefaults(quiKeys.tagFences, { gcTime: Infinity, staleTime: Infinity });
	// Plain-HTTP self-hosting lacks randomUUID. getRandomValues still
	// supplies a collision-resistant 128-bit nonce in that browser context.
	const attemptId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	queryClient.setQueryData<QuiTagFences>(quiKeys.tagFences, (current) => ({
		...current,
		[targetKey]: { attemptId, status: "pending" },
	}));
	return { targetKey, attemptId };
}

export function settleQuiTagAttempt(
	queryClient: QueryClient,
	attempt: ReturnType<typeof beginQuiTagAttempt>,
	acknowledged: boolean,
) {
	queryClient.setQueryData<QuiTagFences>(quiKeys.tagFences, (current) => {
		if (current?.[attempt.targetKey]?.attemptId !== attempt.attemptId) return current;
		return {
			...current,
			[attempt.targetKey]: {
				attemptId: attempt.attemptId,
				status: acknowledged ? "acknowledged" : "unconfirmed",
			},
		};
	});
}

export function completeQuiTagObservation(
	queryClient: QueryClient,
	targetKey: string,
	observedAttempt: QuiTagFence | null,
) {
	// A read started before settlement is not evidence for that attempt.
	if (!observedAttempt || observedAttempt.status === "pending") return;
	queryClient.setQueryData<QuiTagFences>(quiKeys.tagFences, (current) => {
		const held = current?.[targetKey];
		if (!held || held.status === "pending" || held.attemptId !== observedAttempt.attemptId) {
			return current;
		}
		const { [targetKey]: _resolved, ...remaining } = current;
		return remaining;
	});
}
