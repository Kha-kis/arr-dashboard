import type {
	BackupFileInfo,
	BackupPasswordStatus,
	BackupSettings,
	CreateBackupRequest,
	ListBackupsResponse,
	SetBackupPasswordRequest,
	UpdateBackupSettingsRequest,
} from "@arr/shared";
import { apiRequest } from "./base";

export const backupApi = {
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
