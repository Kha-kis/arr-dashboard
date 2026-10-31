import type {
	BackupFileInfo,
	BackupPasswordStatus,
	BackupSettings,
	CreateBackupRequest,
	ListBackupsResponse,
	RestoreBackupRequest,
	RestoreBackupFromFileRequest,
	RestoreBackupResponse,
	RestoreStatusResponse,
	SetBackupPasswordRequest,
	UpdateBackupSettingsRequest,
} from "@arr/shared";
import { restoreBackupResponseSchema, restoreStatusResponseSchema } from "@arr/shared";
import { ApiError, apiRequest, UnauthorizedError } from "./base";

type RejectionCategory =
	| "invalid-backup"
	| "restore-busy"
	| "maintenance-conflict"
	| "destination-unavailable"
	| "restore-rate-limited"
	| "unauthorized";

function readRateLimitSeconds(payload: unknown): number | undefined {
	if (
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		Object.keys(payload).length !== 3 ||
		!("error" in payload) ||
		typeof payload.error !== "string" ||
		payload.error.length > 256 ||
		!("category" in payload) ||
		payload.category !== "restore-rate-limited" ||
		!("retryAfterSeconds" in payload) ||
		typeof payload.retryAfterSeconds !== "number" ||
		!Number.isInteger(payload.retryAfterSeconds) ||
		payload.retryAfterSeconds < 1 ||
		payload.retryAfterSeconds > 300
	)
		return undefined;
	return payload.retryAfterSeconds;
}

function readRejectionCategory(payload: unknown): RejectionCategory | undefined {
	if (
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		Object.keys(payload).length !== 2 ||
		!("error" in payload) ||
		!("category" in payload) ||
		typeof payload.error !== "string" ||
		payload.error.length > 256
	)
		return undefined;
	switch (payload.category) {
		case "invalid-backup":
		case "restore-busy":
		case "maintenance-conflict":
		case "destination-unavailable":
			return payload.category;
		default:
			return undefined;
	}
}

/** A verified refusal before publication, not a completed restore attempt. */
export class RestoreRequestRejectedError extends Error {
	constructor(
		readonly status: number,
		readonly category: RejectionCategory,
		readonly retryAfterSeconds?: number,
	) {
		super("Restore request was rejected before publication.");
		this.name = "RestoreRequestRejectedError";
	}
}

/** Never retain an unverified response, password or transport error as a cause. */
export class RestoreUnconfirmedError extends Error {
	constructor() {
		super("Restore outcome could not be confirmed. Do not repeat the restore request.");
		this.name = "RestoreUnconfirmedError";
	}
}

async function checkedRestore(
	path: string,
	request: RestoreBackupRequest | RestoreBackupFromFileRequest,
): Promise<RestoreBackupResponse> {
	try {
		const raw = await apiRequest<unknown>(path, { json: request, expectedSuccessStatus: 200 });
		const parsed = restoreBackupResponseSchema.safeParse(raw);
		if (!parsed.success || parsed.data.outcome !== "committed") throw new RestoreUnconfirmedError();
		return parsed.data;
	} catch (error) {
		if (error instanceof UnauthorizedError)
			throw new RestoreRequestRejectedError(401, "unauthorized");
		if (error instanceof ApiError) {
			const retryAfterSeconds =
				error.status === 429 ? readRateLimitSeconds(error.payload) : undefined;
			if (retryAfterSeconds !== undefined)
				throw new RestoreRequestRejectedError(429, "restore-rate-limited", retryAfterSeconds);
			const result = restoreBackupResponseSchema.safeParse(error.payload);
			if (
				result.success &&
				((error.status === 409 && result.data.outcome === "not-committed") ||
					(error.status === 503 && result.data.outcome === "unavailable"))
			)
				return result.data;
			const category = readRejectionCategory(error.payload);
			if (category) {
				if (
					([400, 409].includes(error.status) && category === "invalid-backup") ||
					(error.status === 409 && ["restore-busy", "maintenance-conflict"].includes(category)) ||
					(error.status === 503 && category === "destination-unavailable")
				) {
					throw new RestoreRequestRejectedError(error.status, category);
				}
			}
		}
		throw new RestoreUnconfirmedError();
	}
}

export const backupApi = {
	/** Never replay publication; validate both the native disposition and HTTP status. */
	async restoreBackup(request: RestoreBackupRequest): Promise<RestoreBackupResponse> {
		return checkedRestore("/api/backup/restore", request);
	},
	async restoreBackupFromFile(
		request: RestoreBackupFromFileRequest,
	): Promise<RestoreBackupResponse> {
		return checkedRestore("/api/backup/restore-from-file", request);
	},
	/** Latest positive evidence only; a missing/different marker never proves rollback. */
	async getRestoreStatus(): Promise<RestoreStatusResponse> {
		try {
			const raw = await apiRequest<unknown>("/api/backup/restore/status", {
				expectedSuccessStatus: 200,
			});
			const parsed = restoreStatusResponseSchema.safeParse(raw);
			if (parsed.success) return parsed.data;
		} catch (error) {
			if (error instanceof UnauthorizedError) throw error;
		}
		throw new Error("Restore status could not be verified.");
	},
	/**
	 * List all backups from filesystem
	 */
	async listBackups(): Promise<ListBackupsResponse> {
		return apiRequest<ListBackupsResponse>("/api/backup");
	},

	/**
	 * Create an encrypted backup and save to filesystem
	 */
	async createBackup(request: CreateBackupRequest): Promise<BackupFileInfo> {
		return apiRequest<BackupFileInfo>("/api/backup/create", {
			json: request,
		});
	},

	/**
	 * Delete a backup by ID
	 */
	async deleteBackup(id: string): Promise<{ success: boolean; message: string }> {
		return apiRequest<{ success: boolean; message: string }>(`/api/backup/${id}`, {
			method: "DELETE",
		});
	},

	/**
	 * Download a backup file by ID
	 */
	async downloadBackupById(id: string, filename: string): Promise<void> {
		try {
			// Fetch the file as a blob
			const response = await fetch(`/api/backup/${id}/download`);

			if (!response.ok) {
				throw new Error(`Failed to download backup: ${response.statusText}`);
			}

			const blob = await response.blob();

			// Create download link and trigger download
			const url = window.URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = filename;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);

			// Clean up the URL object
			window.URL.revokeObjectURL(url);
		} catch (error) {
			console.error("Failed to download backup:", error);
			throw error;
		}
	},

	/**
	 * Get backup settings
	 */
	async getSettings(): Promise<BackupSettings> {
		return apiRequest<BackupSettings>("/api/backup/settings");
	},

	/**
	 * Update backup settings
	 */
	async updateSettings(request: UpdateBackupSettingsRequest): Promise<BackupSettings> {
		return apiRequest<BackupSettings>("/api/backup/settings", {
			method: "PUT",
			json: request,
		});
	},

	/**
	 * Get backup password configuration status
	 */
	async getPasswordStatus(): Promise<BackupPasswordStatus> {
		return apiRequest<BackupPasswordStatus>("/api/backup/password/status");
	},

	/**
	 * Set or update the backup password
	 */
	async setPassword(
		request: SetBackupPasswordRequest,
	): Promise<{ success: boolean; message: string }> {
		return apiRequest<{ success: boolean; message: string }>("/api/backup/password", {
			method: "PUT",
			json: request,
		});
	},

	/**
	 * Remove the backup password from database
	 */
	async removePassword(): Promise<{ success: boolean; message: string }> {
		return apiRequest<{ success: boolean; message: string }>("/api/backup/password", {
			method: "DELETE",
		});
	},
};
