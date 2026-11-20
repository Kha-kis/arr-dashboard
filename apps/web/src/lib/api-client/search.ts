import {
	type MultiInstanceSearchResponse,
	multiInstanceSearchResponseSchema,
	type ProwlarrIndexerDetails,
	type ProwlarrIndexerHealth,
	type SearchGrabRequest,
	type SearchGrabResultStatusRequest,
	type SearchGrabResultStatusResponse,
	type SearchGrabStatus,
	type SearchIndexerDetailsResponse,
	type SearchIndexersResponse,
	type SearchIndexerTestRequest,
	type SearchIndexerTestResponse,
	type SearchIndexerUpdateChanges,
	type SearchIndexerUpdateOutcome,
	type SearchRequest,
	searchGrabRequestSchema,
	searchGrabResultStatusRequestSchema,
	searchGrabResultStatusResponseSchema,
	searchGrabStatusSchema,
	searchIndexerTestResponseSchema,
} from "@arr/shared";
import { ApiError, apiRequest, UnauthorizedError } from "./base";

export async function fetchSearchIndexers(): Promise<SearchIndexersResponse> {
	return apiRequest<SearchIndexersResponse>("/api/search/indexers");
}

export async function fetchSearchIndexerDetails(
	instanceId: string,
	indexerId: number,
	health?: ProwlarrIndexerHealth,
): Promise<ProwlarrIndexerDetails> {
	// Pass pre-fetched health data as query param to skip redundant stats API call
	const params = health ? `?health=${encodeURIComponent(JSON.stringify(health))}` : "";
	const data = await apiRequest<SearchIndexerDetailsResponse>(
		`/api/search/indexers/${instanceId}/${indexerId}${params}`,
	);
	return data.indexer;
}

export async function performManualSearch(
	payload: SearchRequest,
): Promise<MultiInstanceSearchResponse> {
	const response = await apiRequest<unknown>("/api/search/query", {
		method: "POST",
		json: payload,
	});
	const parsed = multiInstanceSearchResponseSchema.safeParse(response);
	if (
		!parsed.success ||
		parsed.data.aggregated.some(
			(row) =>
				!row.id.trim() || !row.instanceId.trim() || (row.guid !== undefined && !row.guid.trim()),
		)
	)
		throw new Error("Unable to verify search results. Check Prowlarr and retry.");
	return parsed.data;
}

export async function grabManualSearchResult(payload: SearchGrabRequest): Promise<void> {
	const admitted = searchGrabRequestSchema.safeParse(payload);
	if (!admitted.success)
		throw new Error("This result cannot authorize a submission. Run a new search.");
	try {
		await apiRequest<void>("/api/search/grab", {
			method: "POST",
			expectedSuccessStatus: 204,
			json: admitted.data,
		});
	} catch (error) {
		if (
			error instanceof ApiError &&
			error.status >= 400 &&
			error.status < 500 &&
			error.status !== 408 &&
			error.status !== 429
		) {
			throw error;
		}
		// The browser can lose the reply after the server dispatched the Grab.
		// Do not interpret an uncertain response's provider text as rejection proof.
		throw new Error(
			"Could not confirm the grab result. Check Prowlarr and the download client before retrying.",
		);
	}
}

export async function fetchSearchGrabStatus(intentId: string): Promise<SearchGrabStatus> {
	try {
		if (
			!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(intentId)
		)
			throw new Error("Invalid intent");
		const response = await apiRequest<unknown>(
			`/api/search/grab/intents/${encodeURIComponent(intentId)}`,
			{ method: "GET" },
		);
		const status = searchGrabStatusSchema.parse(response);
		if (status.intentId !== intentId) throw new Error("Unrelated intent");
		return status;
	} catch (error) {
		if (error instanceof UnauthorizedError) throw error;
		throw new Error("Submission status is unavailable. Do not submit again without verification.");
	}
}

/** Observation only; never turn a lookup failure into a new submission. */
export async function fetchSearchGrabResultStatuses(
	payload: SearchGrabResultStatusRequest,
): Promise<SearchGrabResultStatusResponse> {
	try {
		const input = searchGrabResultStatusRequestSchema.parse(payload);
		const response = await apiRequest<unknown>("/api/search/grab/results/status", {
			method: "POST",
			expectedSuccessStatus: 200,
			json: input,
		});
		const statuses = searchGrabResultStatusResponseSchema.parse(response);
		if (statuses.results.length !== input.results.length)
			throw new Error("Incomplete status response");
		return statuses;
	} catch (error) {
		if (error instanceof UnauthorizedError) throw error;
		throw new Error("Submission status is unavailable. Do not submit again without verification.");
	}
}

export async function updateSearchIndexer(
	instanceId: string,
	indexerId: number,
	changes: SearchIndexerUpdateChanges,
): Promise<SearchIndexerUpdateOutcome> {
	return apiRequest<SearchIndexerUpdateOutcome>(`/api/search/indexers/${instanceId}/${indexerId}`, {
		method: "PUT",
		json: { changes },
	});
}

export async function testSearchIndexer(
	payload: SearchIndexerTestRequest,
): Promise<SearchIndexerTestResponse> {
	try {
		const response = await apiRequest<unknown>("/api/search/indexers/test", {
			method: "POST",
			json: payload,
		});
		const result = searchIndexerTestResponseSchema.parse(response);
		// Provider messages and extra fields are not public outcome evidence.
		return { success: result.success };
	} catch {
		throw new Error("Unable to confirm indexer test. Check Prowlarr before retrying.");
	}
}
