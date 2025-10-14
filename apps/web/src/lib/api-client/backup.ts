import type {
	BackupFileInfo,
	BackupSettings,
	CreateBackupRequest,
	ListBackupsResponse,
	RestoreBackupFromFileRequest,
	RestoreBackupRequest,
	RestoreBackupResponse,
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
	 * Restore from an encrypted backup (uploaded file)
	 */
	async restoreBackup(request: RestoreBackupRequest): Promise<RestoreBackupResponse> {
		return apiRequest<RestoreBackupResponse>("/api/backup/restore", {
			json: request,
		});
	},

	/**
	 * Restore from a backup stored on filesystem
	 */
	async restoreBackupFromFile(request: RestoreBackupFromFileRequest): Promise<RestoreBackupResponse> {
		return apiRequest<RestoreBackupResponse>("/api/backup/restore-from-file", {
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
	 * Read backup file as base64 string
	 */
	async readBackupFile(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				// FileReader returns ArrayBuffer when using readAsArrayBuffer
				if (reader.result instanceof ArrayBuffer) {
					const uint8Array = new Uint8Array(reader.result);
					// Convert to base64
					const base64 = btoa(String.fromCharCode(...uint8Array));
					resolve(base64);
				} else {
					reject(new Error("Failed to read file as ArrayBuffer"));
				}
			};
			reader.onerror = () => reject(reader.error);
			reader.readAsArrayBuffer(file);
		});
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
};
