const STATUS_LABELS: Record<string, string> = {
	SUCCESS: "SUCCESS",
	PARTIAL_SUCCESS: "PARTIAL SUCCESS",
	FAILED: "FAILED",
	UNCERTAIN: "NEEDS REVIEW",
};

export function getSyncHistoryStatusLabel(status: string): string {
	return STATUS_LABELS[status] ?? status.replaceAll("_", " ");
}
