import type {
	BackupFileInfo,
	BackupPasswordStatus,
	BackupSettings,
	CreateBackupRequest,
	ListBackupsResponse,
	RestoreBackupFromFileRequest,
	RestoreBackupRequest,
	RestoreBackupResponse,
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
	 * Uses chunked processing to avoid call stack overflow on large files
	 */
	async readBackupFile(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				// FileReader returns ArrayBuffer when using readAsArrayBuffer
				if (reader.result instanceof ArrayBuffer) {
					const uint8Array = new Uint8Array(reader.result);

					// Convert to base64 using chunked approach to avoid call stack overflow
					// Process in 8KB chunks to safely handle large files
					const CHUNK_SIZE = 8192;
					let binaryString = '';

					for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
						const chunk = uint8Array.subarray(i, Math.min(i + CHUNK_SIZE, uint8Array.length));
						binaryString += String.fromCharCode(...chunk);
					}

					const base64 = btoa(binaryString);
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

	/**
	 * Get backup password configuration status
	 */
	async getPasswordStatus(): Promise<BackupPasswordStatus> {
		return apiRequest<BackupPasswordStatus>("/api/backup/password/status");
	},

	/**
	 * Set or update the backup password
	 */
	async setPassword(request: SetBackupPasswordRequest): Promise<{ success: boolean; message: string }> {
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
