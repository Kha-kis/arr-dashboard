import type {
  SearchIndexersResponse,
  MultiInstanceSearchResponse,
  SearchRequest,
  SearchGrabRequest,
  SearchIndexerTestRequest,
  SearchIndexerTestResponse,
  SearchIndexerDetailsResponse,
  ProwlarrIndexerDetails,
} from "@arr/shared";
import { apiRequest, UnauthorizedError } from "./base";

const emptyIndexersResponse: SearchIndexersResponse = {
  instances: [],
  aggregated: [],
  totalCount: 0,
};

const emptySearchResponse: MultiInstanceSearchResponse = {
  instances: [],
  aggregated: [],
  totalCount: 0,
};

export async function fetchSearchIndexers(): Promise<SearchIndexersResponse> {
  try {
    return await apiRequest<SearchIndexersResponse>("/api/search/indexers");
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return emptyIndexersResponse;
    }
    throw error;
  }
}

export async function fetchSearchIndexerDetails(instanceId: string, indexerId: number): Promise<ProwlarrIndexerDetails> {
  try {
    const data = await apiRequest<SearchIndexerDetailsResponse>(`/api/search/indexers/${instanceId}/${indexerId}`);
    return data.indexer;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return {
        id: indexerId,
        name: `Indexer ${indexerId}`,
        instanceId,
        instanceName: "",
      };
    }
    throw error;
  }
}

export async function performManualSearch(payload: SearchRequest): Promise<MultiInstanceSearchResponse> {
  try {
    return await apiRequest<MultiInstanceSearchResponse>("/api/search/query", {
      method: "POST",
      json: payload,
    });
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return emptySearchResponse;
    }
    throw error;
  }
}

export async function grabManualSearchResult(payload: SearchGrabRequest): Promise<void> {
  await apiRequest<void>("/api/search/grab", {
    method: "POST",
    json: payload,
  });
}

export async function updateSearchIndexer(instanceId: string, indexerId: number, indexer: ProwlarrIndexerDetails): Promise<ProwlarrIndexerDetails> {
  const payload = { instanceId, indexer };
  const response = await apiRequest<SearchIndexerDetailsResponse>(`/api/search/indexers/${instanceId}/${indexerId}`, {
    method: "PUT",
    json: payload,
  });
  return response.indexer;
}

export async function testSearchIndexer(payload: SearchIndexerTestRequest): Promise<SearchIndexerTestResponse> {
  return await apiRequest<SearchIndexerTestResponse>("/api/search/indexers/test", {
    method: "POST",
    json: payload,
  });
}





