import type { CreateTagResponse, ServiceTagResponse, TagsResponse } from "@arr/shared";
import { apiRequest } from "./base";

export async function fetchTags(): Promise<ServiceTagResponse[]> {
	const data = await apiRequest<TagsResponse>("/api/tags");
	return data.tags;
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
