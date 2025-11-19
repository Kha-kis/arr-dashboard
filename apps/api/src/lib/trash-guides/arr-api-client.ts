/**
 * Radarr/Sonarr API Client for TRaSH Guides Sync
 *
 * Handles Custom Format operations for Radarr and Sonarr instances
 */

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

export interface QualityProfile {
	id: number;
	name: string;
	upgradeAllowed: boolean;
	cutoff: number;
	items: QualityProfileItem[];
	minFormatScore: number;
	cutoffFormatScore: number;
	formatItems: FormatItem[];
	language?: unknown;
}

export interface QualityProfileItem {
	id?: number;
	name?: string;
	quality?: unknown;
	items?: QualityProfileItem[];
	allowed?: boolean;
}

export interface FormatItem {
	format: number; // Custom Format ID
	name?: string;
	score: number;
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
	async getQualityProfiles(): Promise<QualityProfile[]> {
		console.log("[ARR-API] Fetching quality profiles from /api/v3/qualityprofile");
		try {
			const result = await this.request<QualityProfile[]>("GET", "qualityprofile");
			console.log("[ARR-API] Quality profiles SUCCESS:", JSON.stringify(result));
			return result;
		} catch (error) {
			console.error("[ARR-API] Quality profiles FAILED:", error);
			throw error;
		}
	}

	/**
	 * Get Quality Profile by ID
	 */
	async getQualityProfile(id: number): Promise<QualityProfile> {
		return await this.request<QualityProfile>("GET", `qualityprofile/${id}`);
	}

	/**
	 * Get Quality Profile Schema (template for creating new profiles)
	 */
	async getQualityProfileSchema(): Promise<QualityProfile> {
		return await this.request<QualityProfile>("GET", "qualityprofile/schema");
	}

	/**
	 * Create Quality Profile
	 */
	async createQualityProfile(
		profile: Omit<QualityProfile, "id">,
	): Promise<QualityProfile> {
		console.log("[ARR-API] Creating quality profile...");
		console.log("[ARR-API] Profile data:", JSON.stringify(profile, null, 2));
		try {
			const result = await this.request<QualityProfile>("POST", "qualityprofile", profile);
			console.log("[ARR-API] Quality profile created successfully:", JSON.stringify(result));
			return result;
		} catch (error) {
			console.error("[ARR-API] Quality profile creation FAILED:");
			console.error("[ARR-API] Error object:", JSON.stringify(error, null, 2));
			if ((error as { response?: string }).response) {
				console.error("[ARR-API] Full API response:", (error as { response: string }).response);
			}
			// Write full error to file for debugging
			const fs = await import("fs");
			fs.writeFileSync("/tmp/radarr-error.json", JSON.stringify(error, null, 2));
			console.error("[ARR-API] Full error written to /tmp/radarr-error.json");
			throw error;
		}
	}

	/**
	 * Update Quality Profile
	 */
	async updateQualityProfile(
		id: number,
		profile: QualityProfile,
	): Promise<QualityProfile> {
		return await this.request<QualityProfile>(
			"PUT",
			`qualityprofile/${id}`,
			profile,
		);
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
 * Create API client from database instance
 *
 * @param instance - Service instance from database with encrypted API key
 * @param encryptor - Encryptor instance to decrypt the API key (from app.encryptor)
 */
export function createArrApiClient(
	instance: {
		id: string;
		baseUrl: string;
		encryptedApiKey: string;
		encryptionIv: string;
		service: string;
	},
	encryptor: {
		decrypt: (payload: { value: string; iv: string }) => string;
	},
): ArrApiClient {
	// Decrypt API key using the app's encryptor (no code duplication!)
	const apiKey = encryptor.decrypt({
		value: instance.encryptedApiKey,
		iv: instance.encryptionIv,
	});

	return new ArrApiClient({
		id: instance.id,
		baseUrl: instance.baseUrl,
		apiKey,
		service: instance.service as "RADARR" | "SONARR",
	});
}
