/**
 * Seerr utility helpers for the frontend
 */

import {
	SEERR_REQUEST_STATUS,
	SEERR_REQUEST_STATUS_LABEL,
	SEERR_MEDIA_STATUS_LABEL,
	SEERR_ISSUE_TYPE_LABEL,
	SEERR_ISSUE_STATUS,
	SEERR_ISSUE_STATUS_LABEL,
} from "@arr/shared";

// ============================================================================
// Request helpers
// ============================================================================

export function getRequestStatusLabel(status: number): string {
	return SEERR_REQUEST_STATUS_LABEL[status] ?? "Unknown";
}

export function getRequestStatusVariant(status: number): "warning" | "success" | "error" | "info" | "default" {
	switch (status) {
		case SEERR_REQUEST_STATUS.PENDING:
			return "warning";
		case SEERR_REQUEST_STATUS.APPROVED:
			return "success";
		case SEERR_REQUEST_STATUS.DECLINED:
			return "error";
		default:
			return "default";
	}
}

export function getMediaStatusLabel(status: number): string {
	return SEERR_MEDIA_STATUS_LABEL[status] ?? "Unknown";
}

// ============================================================================
// Issue helpers
// ============================================================================

export function getIssueTypeLabel(type: number): string {
	return SEERR_ISSUE_TYPE_LABEL[type] ?? "Other";
}

export function getIssueStatusLabel(status: number): string {
	return SEERR_ISSUE_STATUS_LABEL[status] ?? "Unknown";
}

export function getIssueStatusVariant(status: number): "warning" | "success" | "default" {
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
