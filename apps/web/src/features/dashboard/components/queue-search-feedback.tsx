"use client";

import { Alert, AlertDescription } from "../../../components/ui/alert";
import type { QueueSearchWarning } from "../../../hooks/api/useQueueActions";

export function QueueSearchFeedback({
	warning,
	onDismiss,
}: {
	warning: QueueSearchWarning | null;
	onDismiss: () => void;
}) {
	if (!warning) return null;
	return (
		<Alert variant="warning" dismissible onDismiss={onDismiss}>
			<AlertDescription>
				{warning === "unconfirmed"
					? "Queue items were removed, but search submission was not confirmed."
					: "The queue action could not be verified. Refresh the queue before taking another action."}
				{" Review current Library data before using its search controls. "}
				<a href="/library" className="font-medium underline underline-offset-4">
					Open Library
				</a>
			</AlertDescription>
		</Alert>
	);
}
