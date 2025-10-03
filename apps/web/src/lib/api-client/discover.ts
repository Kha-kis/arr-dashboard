import type {
  DiscoverAddRequest,
  DiscoverAddResponse,
  DiscoverInstanceOptionsResponse,
  DiscoverSearchResponse,
  DiscoverSearchType,
} from "@arr/shared";
import { apiRequest, UnauthorizedError } from "./base";

export interface DiscoverSearchParams {
  query: string;
  type: DiscoverSearchType;
}

export async function fetchDiscoverResults(params: DiscoverSearchParams): Promise<DiscoverSearchResponse> {
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
