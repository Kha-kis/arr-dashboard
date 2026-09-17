import type { SessionAvailability } from "@arr/shared";

interface SessionQuery {
	data?: { sessions: readonly unknown[]; availability?: SessionAvailability };
	isError: boolean;
	isLoading: boolean;
}

/** Display-only coverage. Missing/legacy metadata is not proof of current zero. */
export function summarizeSessionQueries(
	sources: readonly { enabled: boolean; query: SessionQuery }[],
) {
	const enabled = sources.filter((source) => source.enabled).map((source) => source.query);
	const complete =
		enabled.length > 0 &&
		enabled.every(
			(query) =>
				!query.isError &&
				!query.isLoading &&
				query.data?.availability?.status === "complete" &&
				query.data.availability.configuredSources > 0 &&
				query.data.availability.availableSources === query.data.availability.configuredSources,
		);
	const exact =
		complete && enabled.every((query) => query.data?.availability?.configuredSources === 1);
	const hasError = enabled.some((query) => query.isError);
	const loading = enabled.some((query) => query.isLoading);
	const observedCount = enabled.reduce((sum, query) => sum + (query.data?.sessions.length ?? 0), 0);
	const notice = hasError
		? "Session refresh is unavailable. Retained observations may be stale; current totals are unknown."
		: loading
			? "Session data is loading. Current totals are not yet available."
			: !complete
				? "Session coverage is incomplete or unavailable. Current totals are unknown."
				: !exact
					? "Showing session observations from multiple connections. Overlapping sources may duplicate streams."
					: undefined;
	return {
		complete,
		exact,
		loading,
		observedCount,
		exactCount: exact ? observedCount : undefined,
		notice,
	};
}
