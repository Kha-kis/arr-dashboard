import { z } from "zod";

// Backup metadata
export const backupMetadataSchema = z.object({
	version: z.string(),
	appVersion: z.string(),
	timestamp: z.string(),
	dataSize: z.number(),
});

export type BackupMetadata = z.infer<typeof backupMetadataSchema>;

// Create backup request
export const createBackupRequestSchema = z.object({
	password: z
		.string()
		.min(8, "Backup password must be at least 8 characters")
		.max(128, "Backup password must not exceed 128 characters"),
});

export type CreateBackupRequest = z.infer<typeof createBackupRequestSchema>;

// Create backup response (returns encrypted backup as base64 string)
export const createBackupResponseSchema = z.object({
	encryptedBackup: z.string(),
	metadata: backupMetadataSchema,
	filename: z.string(),
});

export type CreateBackupResponse = z.infer<typeof createBackupResponseSchema>;

// Restore backup request
export const restoreBackupRequestSchema = z.object({
	encryptedBackup: z.string(), // Base64 encoded encrypted backup
	password: z.string().min(8).max(128),
});

export type RestoreBackupRequest = z.infer<typeof restoreBackupRequestSchema>;

// Restore backup response
export const restoreBackupResponseSchema = z.object({
	success: z.boolean(),
	message: z.string(),
	restoredAt: z.string(),
	metadata: backupMetadataSchema,
});

export type RestoreBackupResponse = z.infer<typeof restoreBackupResponseSchema>;

// Backup structure (internal, not exposed via API)
export interface BackupData {
	version: string;
	appVersion: string;
	timestamp: string;
	data: {
		users: unknown[];
		sessions: unknown[];
		serviceInstances: unknown[];
		serviceTags: unknown[];
		serviceInstanceTags: unknown[];
		oidcAccounts: unknown[];
		webAuthnCredentials: unknown[];
	};
	secrets: {
		encryptionKey: string;
		sessionCookieSecret: string;
	};
}
