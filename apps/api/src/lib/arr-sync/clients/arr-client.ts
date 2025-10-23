/**
 * ARR Client - Typed wrapper for Sonarr/Radarr API calls
 * Uses the existing createInstanceFetcher pattern to make authenticated requests
 */

import type { FastifyInstance } from "fastify";
import type { ServiceInstance } from "@prisma/client";
import { createInstanceFetcher } from "../../arr/arr-fetcher.js";
import type { CustomFormat, QualityProfile } from "@arr/shared";

export class ArrClient {
	private fetcher: ReturnType<typeof createInstanceFetcher>;

	constructor(
		private app: FastifyInstance,
		private instance: ServiceInstance,
	) {
		this.fetcher = createInstanceFetcher(app, instance);
	}

	// ========================================================================
	// Custom Formats
	// ========================================================================

	async getCustomFormats(): Promise<CustomFormat[]> {
		const response = await this.fetcher("/api/v3/customformat");
		if (!response.ok) {
			throw new Error(
				`Failed to fetch custom formats: ${response.statusText}`,
			);
		}
		return response.json();
	}

	async getCustomFormat(id: number): Promise<CustomFormat> {
		const response = await this.fetcher(`/api/v3/customformat/${id}`);
		if (!response.ok) {
			throw new Error(
				`Failed to fetch custom format ${id}: ${response.statusText}`,
			);
		}
		return response.json();
	}

	async createCustomFormat(data: CustomFormat): Promise<CustomFormat> {
		const response = await this.fetcher("/api/v3/customformat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Failed to create custom format: ${error}`);
		}
		return response.json();
	}

	async updateCustomFormat(
		id: number,
		data: CustomFormat,
	): Promise<CustomFormat> {
		const response = await this.fetcher(`/api/v3/customformat/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...data, id }),
		});
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Failed to update custom format ${id}: ${error}`);
		}
		return response.json();
	}

	async deleteCustomFormat(id: number): Promise<void> {
		const response = await this.fetcher(`/api/v3/customformat/${id}`, {
			method: "DELETE",
		});
		if (!response.ok) {
			throw new Error(
				`Failed to delete custom format ${id}: ${response.statusText}`,
			);
		}
	}

	// ========================================================================
	// Quality Profiles
	// ========================================================================

	async getQualityProfiles(): Promise<QualityProfile[]> {
		const response = await this.fetcher("/api/v3/qualityprofile");
		if (!response.ok) {
			throw new Error(
				`Failed to fetch quality profiles: ${response.statusText}`,
			);
		}
		return response.json();
	}

	async getQualityProfile(id: number): Promise<QualityProfile> {
		const response = await this.fetcher(`/api/v3/qualityprofile/${id}`);
		if (!response.ok) {
			throw new Error(
				`Failed to fetch quality profile ${id}: ${response.statusText}`,
			);
		}
		return response.json();
	}

	async createQualityProfile(data: QualityProfile): Promise<QualityProfile> {
		const response = await this.fetcher("/api/v3/qualityprofile", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Failed to create quality profile: ${error}`);
		}
		return response.json();
	}

	async updateQualityProfile(
		id: number,
		data: QualityProfile,
	): Promise<QualityProfile> {
		const response = await this.fetcher(`/api/v3/qualityprofile/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...data, id }),
		});
		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Failed to update quality profile ${id}: ${error}`);
		}
		return response.json();
	}

	// ========================================================================
	// System
	// ========================================================================

	async getSystemStatus(): Promise<{
		version: string;
		isDocker: boolean;
	}> {
		const response = await this.fetcher("/api/v3/system/status");
		if (!response.ok) {
			throw new Error(
				`Failed to fetch system status: ${response.statusText}`,
			);
		}
		return response.json();
	}

	async testConnection(): Promise<boolean> {
		try {
			await this.getSystemStatus();
			return true;
		} catch {
			return false;
		}
	}
}
