"use client";

import { useId, useRef } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../../components/ui/dialog";
import { Label } from "../../../components/ui/label";
import type { useSearchGrabRecovery } from "../hooks/use-search-grab-recovery";

export function SearchGrabConfirmation({
	recovery,
}: {
	recovery: ReturnType<typeof useSearchGrabRecovery>;
}) {
	const checkboxId = useId();
	const open = Boolean(recovery.confirmation);
	const wasOpen = useRef(false);
	const returnFocus = useRef<HTMLElement | null>(null);
	if (open && !wasOpen.current && typeof document !== "undefined")
		returnFocus.current =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
	wasOpen.current = open;
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) recovery.cancelConfirmation();
			}}
		>
			<DialogContent
				className="max-w-[calc(100vw-2rem)] sm:max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto"
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					if (returnFocus.current?.isConnected) returnFocus.current.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle>Review duplicate submission risk</DialogTitle>
					<DialogDescription>
						This submission may already have reached the download client. Check Prowlarr and the
						download client; submitting again may create a duplicate.
					</DialogDescription>
				</DialogHeader>
				<Alert variant="warning">
					<AlertDescription>
						Continue only after inspecting the earlier submission. A new submission cannot undo a
						possible earlier download.
					</AlertDescription>
				</Alert>
				<div className="flex items-start gap-3">
					<Checkbox
						id={checkboxId}
						checked={recovery.duplicateRiskConfirmed}
						disabled={recovery.confirming}
						onCheckedChange={(checked) => recovery.setDuplicateRiskConfirmed(checked === true)}
					/>
					<Label htmlFor={checkboxId}>
						I understand submitting again may create a duplicate download.
					</Label>
				</div>
				<DialogFooter>
					<Button variant="secondary" onClick={recovery.cancelConfirmation}>
						Cancel
					</Button>
					<Button
						disabled={!recovery.duplicateRiskConfirmed || recovery.confirming}
						onClick={() => void recovery.confirmRetry()}
					>
						{recovery.confirming ? "Checking status…" : "Submit again"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
