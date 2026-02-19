/**
 * Seerr utility helpers for the frontend
 */

import {
	type SeerrRequestStatus,
	type SeerrMediaStatus,
	type SeerrIssueType,
	type SeerrIssueStatus,
	SEERR_REQUEST_STATUS,
	SEERR_REQUEST_STATUS_LABEL,
	SEERR_MEDIA_STATUS,
	SEERR_MEDIA_STATUS_LABEL,
	SEERR_ISSUE_TYPE_LABEL,
	SEERR_ISSUE_STATUS,
	SEERR_ISSUE_STATUS_LABEL,
} from "@arr/shared";

// ============================================================================
// Request helpers
// ============================================================================

export function getRequestStatusLabel(status: SeerrRequestStatus): string {
	return SEERR_REQUEST_STATUS_LABEL[status] ?? `Status ${status}`;
}

export function getRequestStatusVariant(
	status: SeerrRequestStatus,
): "warning" | "success" | "error" | "info" | "default" {
	switch (status) {
		case SEERR_REQUEST_STATUS.PENDING:
			return "warning";
		case SEERR_REQUEST_STATUS.APPROVED:
		case SEERR_REQUEST_STATUS.COMPLETED:
			return "success";
		case SEERR_REQUEST_STATUS.DECLINED:
		case SEERR_REQUEST_STATUS.FAILED:
			return "error";
		default:
			return "default";
	}
}

export function getMediaStatusLabel(status: SeerrMediaStatus): string {
	return SEERR_MEDIA_STATUS_LABEL[status] ?? `Status ${status}`;
}

export function getMediaStatusVariant(
	status: SeerrMediaStatus,
): "warning" | "success" | "error" | "info" | "default" {
	switch (status) {
		case SEERR_MEDIA_STATUS.AVAILABLE:
			return "success";
		case SEERR_MEDIA_STATUS.PARTIALLY_AVAILABLE:
		case SEERR_MEDIA_STATUS.PROCESSING:
			return "info";
		case SEERR_MEDIA_STATUS.PENDING:
			return "warning";
		case SEERR_MEDIA_STATUS.BLOCKLISTED:
		case SEERR_MEDIA_STATUS.DELETED:
			return "error";
		case SEERR_MEDIA_STATUS.UNKNOWN:
		default:
			return "default";
	}
}

// ============================================================================
// Issue helpers
// ============================================================================

export function getIssueTypeLabel(type: SeerrIssueType): string {
	return SEERR_ISSUE_TYPE_LABEL[type] ?? "Other";
}

export function getIssueStatusLabel(status: SeerrIssueStatus): string {
	return SEERR_ISSUE_STATUS_LABEL[status] ?? "Unknown";
}

export function getIssueStatusVariant(status: SeerrIssueStatus): "warning" | "success" | "default" {
	switch (status) {
		case SEERR_ISSUE_STATUS.OPEN:
			return "warning";
		case SEERR_ISSUE_STATUS.RESOLVED:
			return "success";
		default:
			return "default";
	}
}

// ============================================================================
// Formatting
// ============================================================================

export function formatRelativeTime(dateStr: string): string {
	const date = new Date(dateStr);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60_000);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 30) return `${diffDays}d ago`;
	return date.toLocaleDateString();
}

export function getPosterUrl(posterPath?: string | null): string | null {
	if (!posterPath) return null;
	return `https://image.tmdb.org/t/p/w92${posterPath}`;
}
