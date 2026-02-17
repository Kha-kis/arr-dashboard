"use client";

/**
 * Promote Override Dialog
 *
 * Premium dialog for promoting instance-level overrides to templates with:
 * - Glassmorphic container with backdrop blur
 * - Theme-aware styling using THEME_GRADIENTS
 * - SEMANTIC_COLORS for warning states
 * - Animated entrance effects
 */

import { useState, useEffect } from "react";
import { Button } from "../../../components/ui/button";
import { AlertTriangle, ArrowUpCircle, X, Loader2, Layers } from "lucide-react";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { toast } from "sonner";
import { usePromoteOverride } from "../../../hooks/api/useQualityProfileOverrides";
import { getErrorMessage } from "../../../lib/error-utils";

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
	const { gradient: themeGradient } = useThemeGradient();
	const [isPromoting, setIsPromoting] = useState(false);
	const promoteOverride = usePromoteOverride();

	// Handle Escape key
	useEffect(() => {
		if (!open) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !isPromoting) {
				onOpenChange(false);
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [open, onOpenChange, isPromoting]);

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
			const errorMessage = getErrorMessage(error, "Failed to promote override");
			console.error("Failed to promote override:", errorMessage);
			toast.error(errorMessage);
		} finally {
			setIsPromoting(false);
		}
	};

	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={(e) => {
				if (e.target === e.currentTarget && !isPromoting) {
					onOpenChange(false);
				}
			}}
			role="presentation"
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/70 backdrop-blur-xs" />

			{/* Modal */}
			<div
				className="relative w-full max-w-[500px] overflow-hidden rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${themeGradient.from}15`,
				}}
				role="dialog"
				aria-modal="true"
				aria-labelledby="promote-dialog-title"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Close Button */}
				<button
					type="button"
					onClick={() => onOpenChange(false)}
					disabled={isPromoting}
					aria-label="Close"
					className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-white/70 transition-colors hover:bg-black/70 hover:text-white disabled:opacity-50"
				>
					<X className="h-4 w-4" />
				</button>

				{/* Header */}
				<div
					className="border-b border-border/30 p-6"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}08, transparent)`,
					}}
				>
					<div className="flex items-center gap-4">
						<div
							className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<ArrowUpCircle className="h-6 w-6" style={{ color: themeGradient.from }} />
						</div>
						<div>
							<h2 id="promote-dialog-title" className="text-xl font-bold text-foreground">
								Promote Override to Template
							</h2>
							<p className="text-sm text-muted-foreground">
								Update the template so all instances receive this score
							</p>
						</div>
					</div>
				</div>

				{/* Content */}
				<div className="p-6 space-y-5">
					{/* Warning Banner */}
					<div
						className="flex gap-3 rounded-xl p-4"
						style={{
							backgroundColor: SEMANTIC_COLORS.warning.bg,
							border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
						}}
					>
						<AlertTriangle
							className="h-5 w-5 shrink-0 mt-0.5"
							style={{ color: SEMANTIC_COLORS.warning.from }}
						/>
						<div className="text-sm" style={{ color: SEMANTIC_COLORS.warning.text }}>
							<p className="font-medium mb-1">This will affect all instances</p>
							<p className="opacity-90">
								All instances using template &quot;{templateName}&quot; will receive this score on their next sync.
							</p>
						</div>
					</div>

					{/* Score Details */}
					<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs p-4">
						<div className="flex items-center gap-2 mb-3">
							<Layers className="h-4 w-4" style={{ color: themeGradient.from }} />
							<span className="text-sm font-semibold text-foreground">Score Details</span>
						</div>
						<div className="grid grid-cols-2 gap-3 text-sm">
							<div className="text-muted-foreground">Custom Format:</div>
							<div className="font-medium text-foreground">{customFormatName}</div>

							<div className="text-muted-foreground">Current Score:</div>
							<div
								className="font-mono font-bold"
								style={{ color: themeGradient.from }}
							>
								{currentScore}
							</div>

							<div className="text-muted-foreground">Template:</div>
							<div className="font-medium text-foreground">{templateName}</div>
						</div>
					</div>

					{/* What Will Happen */}
					<div
						className="rounded-xl p-4"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}05, ${themeGradient.to}05)`,
							border: `1px solid ${themeGradient.from}15`,
						}}
					>
						<p className="text-sm font-medium text-foreground mb-2">What will happen:</p>
						<ul className="space-y-1.5 text-sm text-muted-foreground">
							<li className="flex items-start gap-2">
								<span style={{ color: themeGradient.from }}>•</span>
								<span>
									Template &quot;{templateName}&quot; will be updated with score:{" "}
									<span className="font-mono font-bold" style={{ color: themeGradient.from }}>
										{currentScore}
									</span>
								</span>
							</li>
							<li className="flex items-start gap-2">
								<span style={{ color: themeGradient.from }}>•</span>
								<span>Instance-level override will be removed (score is now in template)</span>
							</li>
							<li className="flex items-start gap-2">
								<span style={{ color: themeGradient.from }}>•</span>
								<span>All instances using this template will get this score on next deployment/sync</span>
							</li>
						</ul>
					</div>
				</div>

				{/* Footer */}
				<div className="flex justify-end gap-3 p-6 pt-0">
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={isPromoting}
						className="rounded-xl"
					>
						Cancel
					</Button>
					<Button
						onClick={handlePromote}
						disabled={isPromoting}
						className="gap-2 rounded-xl font-medium"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
						}}
					>
						{isPromoting ? (
							<>
								<Loader2 className="h-4 w-4 animate-spin" />
								Promoting...
							</>
						) : (
							<>
								<ArrowUpCircle className="h-4 w-4" />
								Promote to Template
							</>
						)}
					</Button>
				</div>
			</div>
		</div>
	);
}
