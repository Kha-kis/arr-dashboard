import { apiRequest } from "./base";

// ============================================================================
// Types
// ============================================================================

export interface SystemSettings {
	apiPort: number;
	webPort: number;
	listenAddress: string;
	appName: string;
	externalUrl: string | null;
	trustProxy: boolean;
	secureCookies: boolean | null;
	effectiveApiPort: number;
	effectiveWebPort: number;
	effectiveListenAddress: string;
	effectiveTrustProxy: boolean;
	effectiveSecureCookies: boolean;
	requiresRestart: boolean;
	updatedAt: string;
}

export interface SystemSettingsResponse {
	success: boolean;
	data: SystemSettings;
	message?: string;
}

export interface SystemInfo {
	version: string;
	database: {
		type: string;
		host: string | null;
	};
	runtime: {
		nodeVersion: string;
		platform: string;
		uptime: number;
	};
	logging?: {
		level: string;
		logFileEnabled: boolean;
		maxFileSize: string;
		maxFiles: number;
	};
}

export interface SystemInfoResponse {
	success: boolean;
	data: SystemInfo;
}

export interface LogFile {
	name: string;
	size: number;
	modified: string;
}

export interface LogFilesResponse {
	success: boolean;
	data: {
		directory: string;
		files: LogFile[];
	};
}

export interface UpdateSystemSettingsPayload {
	apiPort?: number;
	webPort?: number;
	listenAddress?: string;
	appName?: string;
	externalUrl?: string | null;
	trustProxy?: boolean;
	secureCookies?: boolean | null;
}

// ============================================================================
// API Functions
// ============================================================================

export function fetchSystemSettings(): Promise<SystemSettingsResponse> {
	return apiRequest<SystemSettingsResponse>("/api/system/settings");
}

export function fetchSystemInfo(): Promise<SystemInfoResponse> {
	return apiRequest<SystemInfoResponse>("/api/system/info");
}

export function fetchLogFiles(): Promise<LogFilesResponse> {
	return apiRequest<LogFilesResponse>("/api/system/logs");
}

export function updateSystemSettings(
	data: UpdateSystemSettingsPayload,
): Promise<SystemSettingsResponse> {
	return apiRequest<SystemSettingsResponse>("/api/system/settings", {
		method: "PUT",
		json: data,
	});
}

export function restartSystem(): Promise<{ success: boolean; message: string }> {
	return apiRequest<{ success: boolean; message: string }>("/api/system/restart", {
		method: "POST",
	});
}

export function fetchValidationHealth(): Promise<ValidationHealthResponse> {
	return apiRequest<ValidationHealthResponse>("/api/system/validation-health");
}

export function resetValidationHealth(): Promise<ValidationHealthResponse> {
	return apiRequest<ValidationHealthResponse>("/api/system/validation-health", {
		method: "DELETE",
	});
}

export function fetchValidationQuarantine(): Promise<QuarantineResponse> {
	return apiRequest<QuarantineResponse>("/api/system/validation-quarantine");
}

export function clearValidationQuarantine(): Promise<unknown> {
	return apiRequest("/api/system/validation-quarantine", { method: "DELETE" });
}

export function fetchSecurityPosture(): Promise<SecurityPostureResponse> {
	return apiRequest<SecurityPostureResponse>("/api/system/security-posture");
}

// ============================================================================
// Security Posture Types
// ============================================================================

export type SecuritySeverity = "healthy" | "warning" | "misconfigured";

export interface SecurityCheck {
	id: string;
	label: string;
	detail: string;
	severity: SecuritySeverity;
	remediation?: string;
}

export interface SecurityPosture {
	overall: SecuritySeverity;
	checks: SecurityCheck[];
	effective: {
		nodeEnv: "development" | "test" | "production";
		trustProxy: boolean;
		secureCookies: boolean;
		sessionTtlHours: number;
		sessionCookieName: string;
		passwordPolicy: "strict" | "relaxed";
		appUrl: string;
	};
	auth: {
		passwordEnabled: boolean;
		passwordUserCount: number;
		oidcEnabled: boolean;
		passkeyCount: number;
	};
	capturedAt: string;
}

export interface SecurityPostureResponse {
	success: boolean;
	data: SecurityPosture;
}

// ============================================================================
// Validation Health Types
// ============================================================================

export interface ValidationStats {
	total: number;
	validated: number;
	rejected: number;
}

export type HealthState = "healthy" | "degraded" | "failing";

export interface IntegrationHealth {
	lastRefreshAt: string | null;
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
	consecutiveFailures: number;
	state: HealthState;
	categories: Record<string, ValidationStats>;
	totals: ValidationStats;
}

export interface SchemaFingerprint {
	fields: string[];
	recordedAt: string;
	sampleCount: number;
}

export interface DriftReport {
	newFields: string[];
	missingFields: string[];
	hasDrift: boolean;
}

export interface CategoryFingerprint {
	baseline: SchemaFingerprint;
	latest: SchemaFingerprint;
	drift: DriftReport;
	fieldMissCounts: Record<string, number>;
}

export interface ValidationHealthResponse {
	success: boolean;
	data: {
		integrations: Record<string, IntegrationHealth>;
		overallTotals: ValidationStats;
		validationModes: Record<string, string>;
		resetAt: string | null;
		fingerprints: Record<string, Record<string, CategoryFingerprint>>;
	};
}

export interface QuarantinedItem {
	raw: unknown;
	errors: string[];
	integration: string;
	category: string;
	timestamp: string;
}

export interface QuarantineResponse {
	success: boolean;
	data: {
		items: Record<string, QuarantinedItem[]>;
		totalCount: number;
	};
}

// ============================================================================
// Tautulli Removal Migration (3.0 — ADR-0007)
// ============================================================================

export interface TautulliRuleChange {
	id: string;
	name: string;
	reason: "tautulli-orphaned" | "tautulli-condition-dropped" | "unparseable";
	droppedConditionKinds?: string[];
}

export interface TautulliSurfaceReport {
	rulesScanned: number;
	rulesDisabled: TautulliRuleChange[];
	rulesModified: TautulliRuleChange[];
	rulesUnparseable: TautulliRuleChange[];
}

export interface TautulliPassReport {
	ranAt: string;
	surfaces: {
		"library-cleanup": TautulliSurfaceReport;
		"auto-tag": TautulliSurfaceReport;
	};
	totalAffectedRules: number;
}

export interface TautulliMigrationStatus {
	needed: boolean;
	instances: Array<{ id: string; label: string }>;
	rulesReport: TautulliPassReport | null;
}

export function fetchTautulliMigrationStatus(): Promise<TautulliMigrationStatus> {
	return apiRequest<TautulliMigrationStatus>("/api/system/migrations/tautulli");
}

export function completeTautulliMigration(): Promise<{
	success: boolean;
	removedInstances: number;
}> {
	return apiRequest("/api/system/migrations/tautulli", { method: "POST" });
}
