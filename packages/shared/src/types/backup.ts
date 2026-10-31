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
// Note: Internal path field is kept separate for server-side use only
export const backupFileInfoSchema = z.object({
	id: z.string(), // Hash of filename for unique identification
	filename: z.string(),
	type: z.enum(["manual", "scheduled", "update"]),
	timestamp: z.string(),
	size: z.number(), // File size in bytes (encrypted file size)
});

export type BackupFileInfo = z.infer<typeof backupFileInfoSchema>;

// Internal type with path field (server-side only, not exposed in API responses)
export interface BackupFileInfoInternal extends BackupFileInfo {
	path: string; // Absolute path to backup file
}

// Create backup response (returns backup file info after saving to filesystem)
export const createBackupResponseSchema = backupFileInfoSchema;

export type CreateBackupResponse = z.infer<typeof createBackupResponseSchema>;

// Restore backup request (from uploaded file)
// Max 50 MB base64 (~37.5 MB decoded) — prevents memory exhaustion on upload.
// For larger backups, use the restore-from-file endpoint instead.
export const MAX_BACKUP_UPLOAD_SIZE = 50 * 1024 * 1024;
export const MAX_RESTORE_PASSWORD_LENGTH = 1024;
export const RESTORE_UPLOAD_BODY_LIMIT = MAX_BACKUP_UPLOAD_SIZE + 65536;
const restorePasswordSchema = z.string().min(1).max(MAX_RESTORE_PASSWORD_LENGTH);
export const restoreBackupRequestSchema = z.strictObject({
	backupData: z.string().min(1).max(MAX_BACKUP_UPLOAD_SIZE), // Base64 encoded encrypted envelope
	password: restorePasswordSchema.optional(),
});

export type RestoreBackupRequest = z.infer<typeof restoreBackupRequestSchema>;

// Terminal publication proof, not a generic transport-success acknowledgement.
// An automatic restart is requested, never certified complete by this response.
const restoreResultFields = {
	restoreId: z.uuid(),
	restartRequired: z.literal(true),
	restart: z.enum(["automatic-requested", "manual-required"]),
};
export const restoreBackupResponseSchema = z.discriminatedUnion("outcome", [
	z.strictObject({
		...restoreResultFields,
		outcome: z.literal("committed"),
		success: z.literal(true),
		reason: z.null(),
	}),
	z.strictObject({
		...restoreResultFields,
		outcome: z.literal("not-committed"),
		success: z.literal(false),
		reason: z.literal("state-changed"),
	}),
	z.strictObject({
		...restoreResultFields,
		outcome: z.literal("unavailable"),
		success: z.literal(false),
		reason: z.enum(["ownership-unavailable", "closure-unverified", "commit-unknown"]),
		restart: z.literal("manual-required"),
	}),
]);

export type RestoreBackupResponse = z.infer<typeof restoreBackupResponseSchema>;

// Latest positive evidence only. Absence or mismatch cannot establish rollback.
export const restoreStatusResponseSchema = z.strictObject({
	latestCommitted: z
		.strictObject({ restoreId: z.uuid(), committedAt: z.iso.datetime() })
		.nullable(),
});

export type RestoreStatusResponse = z.infer<typeof restoreStatusResponseSchema>;

// List backups response
export const listBackupsResponseSchema = z.object({
	backups: z.array(backupFileInfoSchema),
});

export type ListBackupsResponse = z.infer<typeof listBackupsResponseSchema>;

// Restore backup from filesystem request
export const restoreBackupFromFileRequestSchema = z.strictObject({
	id: z.string().regex(/^[a-f0-9]{24}$/), // Existing installation-local backup ID
	password: restorePasswordSchema.optional(),
});

export type RestoreBackupFromFileRequest = z.infer<typeof restoreBackupFromFileRequestSchema>;

// Backup structure (internal, not exposed via API)
export type BackupFormatVersion = "1.0" | "1.1" | "1.2" | "1.3" | "1.4" | "1.5" | "1.6";

export interface BackupData {
	version: BackupFormatVersion;
	appVersion: string;
	timestamp: string;
	data: {
		// Core authentication & services (always included)
		users: unknown[];
		sessions: unknown[];
		serviceInstances: unknown[];
		serviceTags: unknown[];
		serviceInstanceTags: unknown[];
		oidcProviders?: unknown[]; // Optional for backward compatibility
		oidcAccounts: unknown[];
		webAuthnCredentials: unknown[];

		// System settings
		systemSettings?: unknown[]; // Optional for backward compatibility

		// TRaSH Guides configuration (user templates & settings)
		trashTemplates?: unknown[];
		trashSettings?: unknown[];
		trashSyncSchedules?: unknown[];
		templateQualityProfileMappings?: unknown[];
		instanceQualityProfileOverrides?: unknown[];
		standaloneCFDeployments?: unknown[];

		// TRaSH Guides history/audit (useful for tracking)
		trashSyncHistory?: unknown[];
		templateDeploymentHistory?: unknown[];
		namingDeployHistory?: unknown[];

		// TRaSH instance backups (ARR config snapshots) - optional, can be large.
		// Recent snapshots follow BackupSettings.includeTrashBackups; snapshots
		// referenced by nonterminal rollback/undeploy coordination are mandatory.
		trashBackups?: unknown[];

		// Quality size preset mappings
		qualitySizeMappings?: unknown[];

		// Hunting feature configuration & history
		huntConfigs?: unknown[];
		huntLogs?: unknown[];
		huntSearchHistory?: unknown[];

		// Durable configuration (runtime validation requires explicit arrays in v1.2;
		// properties remain optional here so legacy payloads remain representable).
		backupSettings?: unknown[];
		vapidKeys?: unknown[];
		notificationChannel?: unknown[];
		notificationSubscription?: unknown[];
		notificationRule?: unknown[];
		notificationAggregationConfig?: unknown[];
		/** Uncapped accepted work; both collections are required in format 1.6. */
		notificationOutboxEvents?: unknown[];
		notificationOutboxDeliveries?: unknown[];
		autoTagRule?: unknown[];
		labelSyncRule?: unknown[];
		/** Durable Jellyfin/Emby desired-state history (optional for legacy files). */
		labelSyncMutationAttempts?: unknown[];
		// Complete safety evidence is mandatory at runtime in formats 1.3 and 1.4.
		// Optional properties retain unknown coverage in older backup formats.
		arrImportOperations?: unknown[];
		arrImportFileProofs?: unknown[];
		arrImportSourceClaims?: unknown[];
		queueCleanerImportReceipts?: unknown[];
		quiActionClaims?: unknown[];
		quiActionLogs?: unknown[];
		/** Complete uncapped Grab safety state is mandatory in format 1.5. */
		searchGrabAttempts?: unknown[];
		searchGrabClaims?: unknown[];
		queueCleanerConfig?: unknown[];
		libraryCleanupConfig?: unknown[];
		libraryCleanupRule?: unknown[];
		librarySyncSettings?: unknown[];
		namingConfig?: unknown[];
		userCustomFormat?: unknown[];
		libraryCleanupApproval?: unknown[];
		libraryCleanupMediaServerScan?: unknown[];
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
	includeTrashBackups: z.boolean(), // Include TRaSH ARR config snapshots (can be large)
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
	includeTrashBackups: z.boolean().optional(), // Include TRaSH ARR config snapshots
});

export type UpdateBackupSettingsRequest = z.infer<typeof updateBackupSettingsRequestSchema>;

// Backup password status
export const backupPasswordStatusSchema = z.object({
	configured: z.boolean(),
	source: z.enum(["database", "environment", "none"]),
	reason: z.enum(["invalid_database_password"]).optional(),
});

export type BackupPasswordStatus = z.infer<typeof backupPasswordStatusSchema>;

// Set backup password request
export const setBackupPasswordRequestSchema = z.object({
	password: z.string().min(8, "Password must be at least 8 characters"),
});

export type SetBackupPasswordRequest = z.infer<typeof setBackupPasswordRequestSchema>;
