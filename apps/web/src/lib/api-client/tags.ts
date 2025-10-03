import type {
  ServiceTagResponse,
  TagsResponse,
  CreateTagResponse,
} from "@arr/shared";
import { apiRequest, UnauthorizedError } from "./base";

export async function fetchTags(): Promise<ServiceTagResponse[]> {
  try {
    const data = await apiRequest<TagsResponse>("/api/tags");
    return data.tags;
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return [];
    }
    throw error;
  }
}

export async function createTag(name: string): Promise<ServiceTagResponse> {
  const data = await apiRequest<CreateTagResponse>("/api/tags", {
    method: "POST",
    json: { name },
  });
  return data.tag;
}

export async function deleteTag(id: string): Promise<void> {
  await apiRequest<void>(`/api/tags/${id}`, {
    method: "DELETE",
  });
}
