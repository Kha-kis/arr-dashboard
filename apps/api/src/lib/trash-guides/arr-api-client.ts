/**
 * Radarr/Sonarr API Client for TRaSH Guides Sync
 *
 * Handles Custom Format operations for Radarr and Sonarr instances
 */

import crypto from "node:crypto";

// ============================================================================
// Types
// ============================================================================

export interface ArrInstance {
	id: string;
	baseUrl: string;
	apiKey: string;
	service: "RADARR" | "SONARR";
}

export interface CustomFormat {
	id?: number;
	name: string;
	includeCustomFormatWhenRenaming?: boolean;
	specifications: CustomFormatSpecification[];
}

export interface CustomFormatSpecification {
	name: string;
	implementation: string;
	negate: boolean;
	required: boolean;
	fields: Record<string, unknown>;
}

export interface SystemStatus {
	version: string;
	buildTime: string;
	isDebug: boolean;
	isProduction: boolean;
	isAdmin: boolean;
	isUserInteractive: boolean;
	startupPath: string;
	appData: string;
	osName: string;
	osVersion: string;
	isNetCore: boolean;
	isMono: boolean;
	isLinux: boolean;
	isOsx: boolean;
	isWindows: boolean;
	mode: string;
	branch: string;
	authentication: string;
	sqliteVersion: string;
	urlBase: string;
	runtimeVersion: string;
	runtimeName: string;
}

export interface ApiError {
	message: string;
	status: number;
	response?: unknown;
}

// ============================================================================
// Arr API Client Class
// ============================================================================

export class ArrApiClient {
	private baseUrl: string;
	private apiKey: string;
	private service: "RADARR" | "SONARR";

	constructor(instance: ArrInstance) {
		this.baseUrl = instance.baseUrl.replace(/\/$/, ""); // Remove trailing slash
		this.apiKey = instance.apiKey;
		this.service = instance.service;
	}

	/**
	 * Make API request to Radarr/Sonarr
	 */
	private async request<T>(
		method: string,
		endpoint: string,
		body?: unknown,
	): Promise<T> {
		const url = `${this.baseUrl}/api/v3/${endpoint}`;

		const headers: Record<string, string> = {
			"X-Api-Key": this.apiKey,
			"Content-Type": "application/json",
		};

		const options: RequestInit = {
			method,
			headers,
		};

		if (body) {
			options.body = JSON.stringify(body);
		}

		try {
			const response = await fetch(url, options);

			if (!response.ok) {
				const errorText = await response.text();
				let errorMessage = `API request failed: ${response.status} ${response.statusText}`;

				try {
					const errorJson = JSON.parse(errorText);
					errorMessage = errorJson.message || errorMessage;
				} catch {
					// Use default error message
				}

				const error: ApiError = {
					message: errorMessage,
					status: response.status,
					response: errorText,
				};

				throw error;
			}

			// Handle empty responses
			const contentType = response.headers.get("content-type");
			if (!contentType?.includes("application/json")) {
				return {} as T;
			}

			return (await response.json()) as T;
		} catch (error) {
			if ((error as ApiError).status) {
				throw error;
			}

			throw {
				message: error instanceof Error ? error.message : "Network error",
				status: 0,
			} as ApiError;
		}
	}

	/**
	 * Get system status and version
	 */
	async getSystemStatus(): Promise<SystemStatus> {
		return await this.request<SystemStatus>("GET", "system/status");
	}

	/**
	 * Test API connection
	 */
	async testConnection(): Promise<boolean> {
		try {
			await this.getSystemStatus();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get all Custom Formats
	 */
	async getCustomFormats(): Promise<CustomFormat[]> {
		return await this.request<CustomFormat[]>("GET", "customformat");
	}

	/**
	 * Get Custom Format by ID
	 */
	async getCustomFormat(id: number): Promise<CustomFormat> {
		return await this.request<CustomFormat>("GET", `customformat/${id}`);
	}

	/**
	 * Create new Custom Format
	 */
	async createCustomFormat(format: CustomFormat): Promise<CustomFormat> {
		return await this.request<CustomFormat>("POST", "customformat", format);
	}

	/**
	 * Update existing Custom Format
	 */
	async updateCustomFormat(
		id: number,
		format: CustomFormat,
	): Promise<CustomFormat> {
		return await this.request<CustomFormat>(
			"PUT",
			`customformat/${id}`,
			format,
		);
	}

	/**
	 * Delete Custom Format
	 */
	async deleteCustomFormat(id: number): Promise<void> {
		await this.request("DELETE", `customformat/${id}`);
	}

	/**
	 * Get Quality Profiles
	 */
	async getQualityProfiles(): Promise<unknown[]> {
		return await this.request<unknown[]>("GET", "qualityprofile");
	}

	/**
	 * Find Custom Format by name
	 */
	async findCustomFormatByName(name: string): Promise<CustomFormat | null> {
		const formats = await this.getCustomFormats();
		return formats.find((f) => f.name === name) || null;
	}

	/**
	 * Check if Custom Format exists (by name)
	 */
	async customFormatExists(name: string): Promise<boolean> {
		const format = await this.findCustomFormatByName(name);
		return format !== null;
	}
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Decrypt API key using stored encryption data
 */
export function decryptApiKey(
	encryptedApiKey: string,
	encryptionIv: string,
): string {
	const algorithm = "aes-256-gcm";
	const key = Buffer.from(process.env.ENCRYPTION_KEY || "", "hex");
	const iv = Buffer.from(encryptionIv, "hex");

	// Extract auth tag (last 16 bytes) and encrypted data
	const encryptedBuffer = Buffer.from(encryptedApiKey, "hex");
	const authTag = encryptedBuffer.subarray(encryptedBuffer.length - 16);
	const encrypted = encryptedBuffer.subarray(0, encryptedBuffer.length - 16);

	const decipher = crypto.createDecipheriv(algorithm, key, iv);
	decipher.setAuthTag(authTag);

	let decrypted = decipher.update(encrypted);
	decrypted = Buffer.concat([decrypted, decipher.final()]);

	return decrypted.toString("utf8");
}

/**
 * Create API client from database instance
 */
export function createArrApiClient(instance: {
	id: string;
	baseUrl: string;
	encryptedApiKey: string;
	encryptionIv: string;
	service: string;
}): ArrApiClient {
	const apiKey = decryptApiKey(instance.encryptedApiKey, instance.encryptionIv);

	return new ArrApiClient({
		id: instance.id,
		baseUrl: instance.baseUrl,
		apiKey,
		service: instance.service as "RADARR" | "SONARR",
	});
}
