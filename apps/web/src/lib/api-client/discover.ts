import type {
	DiscoverAddRequest,
	DiscoverAddResponse,
	DiscoverInstanceOptionsResponse,
	DiscoverSearchResponse,
	DiscoverSearchType,
	RecommendationsRequest,
	RecommendationsResponse,
} from "@arr/shared";
import { apiRequest, UnauthorizedError } from "./base";

export interface DiscoverSearchParams {
	query: string;
	type: DiscoverSearchType;
}

export async function fetchDiscoverResults(
	params: DiscoverSearchParams,
): Promise<DiscoverSearchResponse> {
	const search = new URLSearchParams();
	search.set("query", params.query);
	search.set("type", params.type);

	try {
		return await apiRequest<DiscoverSearchResponse>(`/api/discover/search?${search.toString()}`);
	} catch (error) {
		if (error instanceof UnauthorizedError) {
			return { results: [], totalCount: 0 };
		}
		throw error;
	}
}

export async function fetchDiscoverOptions(
	instanceId: string,
	type: DiscoverSearchType,
): Promise<DiscoverInstanceOptionsResponse> {
	const search = new URLSearchParams();
	search.set("instanceId", instanceId);
	search.set("type", type);

	return apiRequest<DiscoverInstanceOptionsResponse>(`/api/discover/options?${search.toString()}`);
}

export async function addDiscoverItem(payload: DiscoverAddRequest): Promise<DiscoverAddResponse> {
	return apiRequest<DiscoverAddResponse>("/api/discover/add", {
		method: "POST",
		json: payload,
	});
}

export async function fetchRecommendations(
	params: RecommendationsRequest,
): Promise<RecommendationsResponse> {
	const search = new URLSearchParams();
	search.set("type", params.type);
	search.set("mediaType", params.mediaType);
	if (params.page) {
		search.set("page", params.page.toString());
	}

	try {
		return await apiRequest<RecommendationsResponse>(`/api/recommendations?${search.toString()}`);
	} catch (error) {
		if (error instanceof UnauthorizedError) {
			return {
				type: params.type,
				mediaType: params.mediaType,
				items: [],
				totalResults: 0,
				page: 1,
				totalPages: 0,
			};
		}
		throw error;
	}
}
