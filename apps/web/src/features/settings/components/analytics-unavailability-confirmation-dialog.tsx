"use client";

import type { AnalyticsProvider } from "@arr/shared";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../../components/ui";

const providerLabel = (provider: AnalyticsProvider) =>
	provider === "tracearr" ? "Tracearr" : "Tautulli";

type AnalyticsUnavailabilityConfirmationDialogProps = {
	selected: AnalyticsProvider | null;
	alternativeEnabled: boolean;
	onConfirm: () => Promise<void>;
	onCancel: () => void;
};

export function AnalyticsUnavailabilityConfirmationDialog({
	selected,
	alternativeEnabled,
	onConfirm,
	onCancel,
}: AnalyticsUnavailabilityConfirmationDialogProps) {
	return (
		<Dialog open={selected !== null} onOpenChange={(open) => !open && onCancel()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Keep historical analytics provider selected?</DialogTitle>
					<DialogDescription>
						{selected
							? `${providerLabel(selected)} will remain selected`
							: "The provider will remain selected"}{" "}
						for historical analytics but will be unavailable after this service change.{" "}
						{alternativeEnabled
							? "The other provider family will not be selected automatically."
							: "No alternative provider family is enabled."}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="secondary" onClick={onCancel}>
						Cancel
					</Button>
					<Button onClick={() => void onConfirm()}>Confirm service change</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
