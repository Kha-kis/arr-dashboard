import type {
	CreateBackupRequest,
	CreateBackupResponse,
	RestoreBackupRequest,
	RestoreBackupResponse,
} from "@arr/shared";
import { apiRequest } from "./base";

export const backupApi = {
	/**
	 * Create an encrypted backup
	 */
	async createBackup(request: CreateBackupRequest): Promise<CreateBackupResponse> {
		return apiRequest<CreateBackupResponse>("/api/backup/create", {
			json: request,
		});
	},

	/**
	 * Restore from an encrypted backup
	 */
	async restoreBackup(request: RestoreBackupRequest): Promise<RestoreBackupResponse> {
		return apiRequest<RestoreBackupResponse>("/api/backup/restore", {
			json: request,
		});
	},

	/**
	 * Download backup as a file
	 */
	downloadBackupFile(encryptedBackup: string, filename: string): void {
		// Convert base64 string to blob
		const byteCharacters = atob(encryptedBackup);
		const byteNumbers = new Array(byteCharacters.length);
		for (let i = 0; i < byteCharacters.length; i++) {
			byteNumbers[i] = byteCharacters.charCodeAt(i);
		}
		const byteArray = new Uint8Array(byteNumbers);
		const blob = new Blob([byteArray], { type: "application/octet-stream" });

		// Create download link and trigger download
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
		URL.revokeObjectURL(url);
	},

	/**
	 * Read backup file as base64 string
	 */
	async readBackupFile(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				if (typeof reader.result === "string") {
					// Remove data URL prefix if present
					const base64 = reader.result.split(",")[1] || reader.result;
					resolve(base64);
				} else {
					reject(new Error("Failed to read file as text"));
				}
			};
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(file);
		});
	},
};
