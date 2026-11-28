import type { DashboardStatisticsEnvelope } from "@arr/shared";

const CURRENT_MAX_MS = 15 * 60_000;
const LAST_KNOWN_MAX_MS = 24 * 60 * 60_000;

/** Prevent a retained browser query from outliving the server's freshness contract. */
export function resolveDashboardStatisticsState(
	envelope: DashboardStatisticsEnvelope | undefined,
	error: unknown,
	nowMs: number,
): DashboardStatisticsEnvelope {
	if (!envelope) {
		return { availability: error ? "unavailable" : "collecting", observedAt: null, data: null };
	}
	if (envelope.data === null) {
		return error && envelope.availability === "collecting"
			? { availability: "unavailable", observedAt: null, data: null }
			: envelope;
	}
	const observedAtMs = Date.parse(envelope.observedAt);
	const ageMs = nowMs - observedAtMs;
	if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > LAST_KNOWN_MAX_MS) {
		return { availability: "unavailable", observedAt: null, data: null };
	}
	if (envelope.availability === "current" && (ageMs > CURRENT_MAX_MS || error)) {
		return { ...envelope, availability: "last-known" };
	}
	return envelope;
}
