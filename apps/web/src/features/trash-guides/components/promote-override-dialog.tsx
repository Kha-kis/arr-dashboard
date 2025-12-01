"use client";

import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../../components/ui/dialog";
import { Button } from "../../../components/ui/button";
import { AlertTriangle, ArrowUpCircle } from "lucide-react";
import { toast } from "sonner";
import { usePromoteOverride } from "../../../hooks/api/useQualityProfileOverrides";

interface PromoteOverrideDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	instanceId: string;
	qualityProfileId: number;
	customFormatId: number;
	customFormatName: string;
	currentScore: number;
	templateId: string;
	templateName: string;
	onSuccess?: () => void;
}

export function PromoteOverrideDialog({
	open,
	onOpenChange,
	instanceId,
	qualityProfileId,
	customFormatId,
	customFormatName,
	currentScore,
	templateId,
	templateName,
	onSuccess,
}: PromoteOverrideDialogProps) {
	const [isPromoting, setIsPromoting] = useState(false);
	const promoteOverride = usePromoteOverride();

	const handlePromote = async () => {
		setIsPromoting(true);
		try {
			await promoteOverride.mutateAsync({
				instanceId,
				qualityProfileId,
				payload: {
					customFormatId,
					templateId,
				},
			});

			onSuccess?.();
			onOpenChange(false);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Failed to promote override";
			// Log only sanitized error message without stack traces or response bodies
			console.error("Failed to promote override:", errorMessage);
			toast.error(errorMessage);
		} finally {
			setIsPromoting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[500px]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<ArrowUpCircle className="h-5 w-5 text-blue-500" />
						Promote Override to Template
					</DialogTitle>
					<DialogDescription>
						Update the template so all instances using it receive this score change.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-4">
					{/* Warning Banner */}
					<div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
						<AlertTriangle className="h-5 w-5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
						<div className="text-sm text-amber-900 dark:text-amber-200">
							<p className="font-medium mb-1">This will affect all instances</p>
							<p className="text-amber-800 dark:text-amber-300">
								All instances using template &quot;{templateName}&quot; will receive this score on their next sync.
							</p>
						</div>
					</div>

					{/* Score Details */}
					<div className="space-y-2 rounded-lg border bg-muted/50 p-4">
						<div className="grid grid-cols-2 gap-2 text-sm">
							<div className="text-muted-foreground">Custom Format:</div>
							<div className="font-medium">{customFormatName}</div>

							<div className="text-muted-foreground">Current Score:</div>
							<div className="font-mono font-bold text-blue-600 dark:text-blue-400">
								{currentScore}
							</div>

							<div className="text-muted-foreground">Template:</div>
							<div className="font-medium">{templateName}</div>
						</div>
					</div>

					{/* What Will Happen */}
					<div className="space-y-2 text-sm">
						<p className="font-medium">What will happen:</p>
						<ul className="list-disc space-y-1 pl-5 text-muted-foreground">
							<li>Template &quot;{templateName}&quot; will be updated with score: <span className="font-mono font-bold">{currentScore}</span></li>
							<li>Instance-level override will be removed (score is now in template)</li>
							<li>All instances using this template will get this score on next deployment/sync</li>
						</ul>
					</div>
				</div>

				<DialogFooter>
					<Button
						variant="secondary"
						onClick={() => onOpenChange(false)}
						disabled={isPromoting}
					>
						Cancel
					</Button>
					<Button
						onClick={handlePromote}
						disabled={isPromoting}
						className="gap-2"
					>
						<ArrowUpCircle className="h-4 w-4" />
						{isPromoting ? "Promoting..." : "Promote to Template"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
