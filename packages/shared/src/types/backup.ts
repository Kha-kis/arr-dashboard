import { z } from "zod";

// Backup metadata
export const backupMetadataSchema = z.object({
	version: z.string(),
	appVersion: z.string(),
	timestamp: z.string(),
	dataSize: z.number(),
});

export type BackupMetadata = z.infer<typeof backupMetadataSchema>;

// Create backup request (no password needed - relies on filesystem security)
export const createBackupRequestSchema = z.object({
	// Future: Could add options like 'description', 'type', etc.
});

export type CreateBackupRequest = z.infer<typeof createBackupRequestSchema>;

// Backup file info (stored on filesystem)
export const backupFileInfoSchema = z.object({
	id: z.string(), // Hash of filename for unique identification
	filename: z.string(),
	type: z.enum(["manual", "scheduled", "update"]),
	timestamp: z.string(),
	size: z.number(), // File size in bytes
	path: z.string(), // Absolute path to backup file
});

export type BackupFileInfo = z.infer<typeof backupFileInfoSchema>;

// Create backup response (returns backup file info after saving to filesystem)
export const createBackupResponseSchema = backupFileInfoSchema;

export type CreateBackupResponse = z.infer<typeof createBackupResponseSchema>;

// Restore backup request (from uploaded file)
export const restoreBackupRequestSchema = z.object({
	backupData: z.string(), // Base64 encoded backup JSON
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

// List backups response
export const listBackupsResponseSchema = z.object({
	backups: z.array(backupFileInfoSchema),
});

export type ListBackupsResponse = z.infer<typeof listBackupsResponseSchema>;

// Delete backup request
export const deleteBackupRequestSchema = z.object({
	id: z.string(),
});

export type DeleteBackupRequest = z.infer<typeof deleteBackupRequestSchema>;

// Restore backup from filesystem request
export const restoreBackupFromFileRequestSchema = z.object({
	id: z.string(), // Backup ID to restore from filesystem
});

export type RestoreBackupFromFileRequest = z.infer<typeof restoreBackupFromFileRequestSchema>;

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
		oidcProviders?: unknown[]; // Optional for backward compatibility
		oidcAccounts: unknown[];
		webAuthnCredentials: unknown[];
	};
	secrets: {
		encryptionKey: string;
		sessionCookieSecret: string;
	};
}

// Backup interval types
export const backupIntervalTypeSchema = z.enum(["DISABLED", "HOURLY", "DAILY", "WEEKLY"]);
export type BackupIntervalType = z.infer<typeof backupIntervalTypeSchema>;

// Backup settings
export const backupSettingsSchema = z.object({
	id: z.number(),
	enabled: z.boolean(),
	intervalType: backupIntervalTypeSchema,
	intervalValue: z.number(), // Hours for HOURLY, days for DAILY (1-7), 1 for WEEKLY
	retentionCount: z.number(), // Number of scheduled backups to keep
	lastRunAt: z.string().nullable(),
	nextRunAt: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export type BackupSettings = z.infer<typeof backupSettingsSchema>;

// Update backup settings request
export const updateBackupSettingsRequestSchema = z.object({
	enabled: z.boolean().optional(),
	intervalType: backupIntervalTypeSchema.optional(),
	intervalValue: z.number().min(1).max(168).optional(), // 1 hour to 1 week
	retentionCount: z.number().min(1).max(100).optional(),
});

export type UpdateBackupSettingsRequest = z.infer<typeof updateBackupSettingsRequestSchema>;
