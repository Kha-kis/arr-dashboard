"use client";

import { useState, useEffect, useRef } from "react";
import { Button } from "../../../components/ui";
import { Clock, X, Calendar, AlertCircle, Loader2, Check, Bell, Zap, Power } from "lucide-react";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

interface TemplateScheduleModalProps {
	open: boolean;
	onClose: () => void;
	templateName: string;
	instanceName: string;
	existingSchedule?: {
		id: string;
		frequency: "DAILY" | "WEEKLY" | "MONTHLY";
		enabled: boolean;
		autoApply: boolean;
		notifyUser: boolean;
	} | null;
	onSave: (schedule: {
		frequency: "DAILY" | "WEEKLY" | "MONTHLY";
		enabled: boolean;
		autoApply: boolean;
		notifyUser: boolean;
	}) => Promise<void>;
}

const frequencyOptions = [
	{ value: "DAILY", label: "Daily" },
	{ value: "WEEKLY", label: "Weekly" },
	{ value: "MONTHLY", label: "Monthly" },
] as const;

/**
 * Premium Template Schedule Modal
 *
 * Modal for scheduling template syncs with:
 * - Glassmorphic backdrop and container
 * - Theme-aware form controls and toggles
 * - Premium badge styling
 * - Animated entrance/exit
 */
export const TemplateScheduleModal = ({
	open,
	onClose,
	templateName,
	instanceName,
	existingSchedule,
	onSave,
}: TemplateScheduleModalProps) => {
	const [frequency, setFrequency] = useState<"DAILY" | "WEEKLY" | "MONTHLY">(
		existingSchedule?.frequency || "WEEKLY"
	);
	const [enabled, setEnabled] = useState(existingSchedule?.enabled ?? true);
	const [autoApply, setAutoApply] = useState(existingSchedule?.autoApply ?? false);
	const [notifyUser, setNotifyUser] = useState(existingSchedule?.notifyUser ?? true);
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	const modalRef = useRef<HTMLDivElement>(null);
	const previousActiveElement = useRef<HTMLElement | null>(null);
	const previousOpenRef = useRef<boolean>(false);

	// Restore focus when modal closes (transitions from open to closed)
	useEffect(() => {
		if (previousOpenRef.current === true && open === false) {
			previousActiveElement.current?.focus();
		}
		previousOpenRef.current = open;
	}, [open]);

	// Reset form state when modal opens or existingSchedule changes
	useEffect(() => {
		if (open) {
			setFrequency(existingSchedule?.frequency || "WEEKLY");
			setEnabled(existingSchedule?.enabled ?? true);
			setAutoApply(existingSchedule?.autoApply ?? false);
			setNotifyUser(existingSchedule?.notifyUser ?? true);
			setError(null);

			// Store the previously focused element
			previousActiveElement.current = document.activeElement as HTMLElement;

			// Focus the modal
			setTimeout(() => {
				modalRef.current?.focus();
			}, 0);
		}
	}, [open, existingSchedule]);

	// Handle Escape key and focus trap
	useEffect(() => {
		if (!open) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
				return;
			}

			// Focus trap
			if (e.key === "Tab" && modalRef.current) {
				const focusableElements = modalRef.current.querySelectorAll<HTMLElement>(
					'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
				);
				const firstElement = focusableElements[0];
				const lastElement = focusableElements[focusableElements.length - 1];

				if (e.shiftKey && document.activeElement === firstElement) {
					e.preventDefault();
					lastElement?.focus();
				} else if (!e.shiftKey && document.activeElement === lastElement) {
					e.preventDefault();
					firstElement?.focus();
				}
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
		};
	}, [open, onClose]);

	const handleSave = async () => {
		setIsSaving(true);
		setError(null);
		try {
			await onSave({
				frequency,
				enabled,
				autoApply,
				notifyUser,
			});
			onClose();
		} catch (err) {
			console.error("Failed to save schedule:", err);
			setError(err instanceof Error ? err.message : "Failed to save schedule. Please try again.");
		} finally {
			setIsSaving(false);
		}
	};

	if (!open) return null;

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled in useEffect for consistent modal behavior
		<div
			className="fixed inset-0 z-modal-backdrop flex items-center justify-center p-4 animate-in fade-in duration-200"
			onClick={onClose}
		>
			{/* Backdrop */}
			<div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

			{/* Modal */}
			{/* biome-ignore lint/a11y/useSemanticElements: Using custom modal with proper ARIA for consistent styling */}
			<div
				ref={modalRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="schedule-modal-title"
				tabIndex={-1}
				className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 slide-in-from-bottom-4 duration-300"
				style={{
					boxShadow: `0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px ${themeGradient.from}15`,
				}}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Close Button */}
				<button
					type="button"
					onClick={onClose}
					aria-label="Close dialog"
					className="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-black/50 text-white/70 transition-colors hover:bg-black/70 hover:text-white"
				>
					<X className="h-4 w-4" />
				</button>

				{/* Header */}
				<div
					className="p-6 border-b border-border/30"
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
							<Clock className="h-6 w-6" style={{ color: themeGradient.from }} />
						</div>
						<div>
							<h2
								id="schedule-modal-title"
								className="text-xl font-bold"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									WebkitBackgroundClip: "text",
									WebkitTextFillColor: "transparent",
								}}
							>
								{existingSchedule ? "Edit Sync Schedule" : "Create Sync Schedule"}
							</h2>
							<p className="text-sm text-muted-foreground">
								Automatically sync &quot;{templateName}&quot; to {instanceName}
							</p>
						</div>
					</div>
				</div>

				{/* Content */}
				<div className="p-6 space-y-6 max-h-[60vh] overflow-y-auto">
					{/* Error Alert */}
					{error && (
						<div
							className="flex items-start gap-3 rounded-xl px-4 py-3 text-sm animate-in fade-in slide-in-from-bottom-2"
							style={{
								backgroundColor: SEMANTIC_COLORS.error.bg,
								border: `1px solid ${SEMANTIC_COLORS.error.border}`,
							}}
						>
							<AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" style={{ color: SEMANTIC_COLORS.error.from }} />
							<div style={{ color: SEMANTIC_COLORS.error.text }}>
								<p className="font-medium">Error</p>
								<p className="text-sm opacity-90">{error}</p>
							</div>
						</div>
					)}

					{/* Frequency Selection */}
					<div className="space-y-3">
						<label className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground font-medium">
							<Calendar className="h-3 w-3" />
							Sync Frequency
						</label>
						<div className="grid grid-cols-3 gap-3">
							{frequencyOptions.map((option) => (
								<button
									key={option.value}
									type="button"
									onClick={() => setFrequency(option.value)}
									className="relative rounded-xl border p-4 text-center transition-all duration-200"
									style={{
										borderColor: frequency === option.value ? themeGradient.from : "hsl(var(--border) / 0.5)",
										background: frequency === option.value
											? `linear-gradient(135deg, ${themeGradient.from}10, ${themeGradient.to}10)`
											: "hsl(var(--card) / 0.3)",
										boxShadow: frequency === option.value ? `0 0 0 1px ${themeGradient.from}` : undefined,
									}}
								>
									{frequency === option.value && (
										<div
											className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full"
											style={{
												background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
											}}
										>
											<Check className="h-3 w-3 text-white" />
										</div>
									)}
									<span
										className="text-sm font-medium"
										style={{ color: frequency === option.value ? themeGradient.from : undefined }}
									>
										{option.label}
									</span>
								</button>
							))}
						</div>
						<p className="text-xs text-muted-foreground">
							How often the template should sync to this instance
						</p>
					</div>

					{/* Options */}
					<div className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4 space-y-4">
						<h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
							Sync Options
						</h3>

						{/* Enabled Toggle */}
						<label className="flex items-center justify-between cursor-pointer group">
							<div className="flex items-start gap-3">
								<div
									className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
									style={{
										background: enabled ? `${themeGradient.from}20` : "hsl(var(--muted) / 0.3)",
									}}
								>
									<Power className="h-4 w-4" style={{ color: enabled ? themeGradient.from : "hsl(var(--muted-foreground))" }} />
								</div>
								<div>
									<span className="text-sm font-medium text-foreground">Enable Schedule</span>
									<p className="text-xs text-muted-foreground mt-0.5">
										Turn this schedule on or off without deleting it
									</p>
								</div>
							</div>
							<div
								className="relative h-6 w-11 rounded-full transition-colors duration-200"
								style={{
									background: enabled
										? `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`
										: "hsl(var(--muted) / 0.5)",
								}}
							>
								<div
									className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
										enabled ? "translate-x-6" : "translate-x-1"
									}`}
								/>
							</div>
							<input
								type="checkbox"
								className="sr-only"
								checked={enabled}
								onChange={(e) => setEnabled(e.target.checked)}
							/>
						</label>

						{/* Auto Apply Toggle */}
						<label className="flex items-center justify-between cursor-pointer group">
							<div className="flex items-start gap-3">
								<div
									className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
									style={{
										background: autoApply ? `${themeGradient.from}20` : "hsl(var(--muted) / 0.3)",
									}}
								>
									<Zap className="h-4 w-4" style={{ color: autoApply ? themeGradient.from : "hsl(var(--muted-foreground))" }} />
								</div>
								<div>
									<span className="text-sm font-medium text-foreground">Auto-Apply Changes</span>
									<p className="text-xs text-muted-foreground mt-0.5">
										Automatically deploy changes to {instanceName} without manual approval
									</p>
								</div>
							</div>
							<div
								className="relative h-6 w-11 rounded-full transition-colors duration-200"
								style={{
									background: autoApply
										? `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`
										: "hsl(var(--muted) / 0.5)",
								}}
							>
								<div
									className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
										autoApply ? "translate-x-6" : "translate-x-1"
									}`}
								/>
							</div>
							<input
								type="checkbox"
								className="sr-only"
								checked={autoApply}
								onChange={(e) => setAutoApply(e.target.checked)}
							/>
						</label>

						{/* Notify Toggle */}
						<label className="flex items-center justify-between cursor-pointer group">
							<div className="flex items-start gap-3">
								<div
									className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
									style={{
										background: notifyUser ? `${themeGradient.from}20` : "hsl(var(--muted) / 0.3)",
									}}
								>
									<Bell className="h-4 w-4" style={{ color: notifyUser ? themeGradient.from : "hsl(var(--muted-foreground))" }} />
								</div>
								<div>
									<span className="text-sm font-medium text-foreground">Notify on Sync</span>
									<p className="text-xs text-muted-foreground mt-0.5">
										Get notified when scheduled syncs complete
									</p>
								</div>
							</div>
							<div
								className="relative h-6 w-11 rounded-full transition-colors duration-200"
								style={{
									background: notifyUser
										? `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`
										: "hsl(var(--muted) / 0.5)",
								}}
							>
								<div
									className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${
										notifyUser ? "translate-x-6" : "translate-x-1"
									}`}
								/>
							</div>
							<input
								type="checkbox"
								className="sr-only"
								checked={notifyUser}
								onChange={(e) => setNotifyUser(e.target.checked)}
							/>
						</label>
					</div>

					{/* Info Box */}
					<div
						className="rounded-xl border p-4"
						style={{
							borderColor: `${themeGradient.from}30`,
							background: `linear-gradient(135deg, ${themeGradient.from}08, ${themeGradient.to}08)`,
						}}
					>
						<div className="flex gap-3">
							<div
								className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
								style={{
									background: `${themeGradient.from}20`,
								}}
							>
								<Calendar className="h-4 w-4" style={{ color: themeGradient.from }} />
							</div>
							<div className="text-sm">
								<p className="font-medium text-foreground mb-2">How Sync Schedules Work</p>
								<ul className="space-y-1.5 text-xs text-muted-foreground">
									<li className="flex items-start gap-2">
										<span style={{ color: themeGradient.from }}>•</span>
										Schedule checks for template updates at the specified frequency
									</li>
									<li className="flex items-start gap-2">
										<span style={{ color: themeGradient.from }}>•</span>
										If updates are found, they&apos;re either auto-applied or require approval
									</li>
									<li className="flex items-start gap-2">
										<span style={{ color: themeGradient.from }}>•</span>
										You can manually sync anytime using the Sync button
									</li>
								</ul>
							</div>
						</div>
					</div>
				</div>

				{/* Footer */}
				<div className="flex justify-end gap-3 border-t border-border/30 p-6">
					<Button variant="outline" onClick={onClose} className="rounded-xl">
						Cancel
					</Button>
					<Button
						onClick={handleSave}
						disabled={isSaving}
						className="gap-2 rounded-xl font-medium"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
						}}
					>
						{isSaving ? (
							<>
								<Loader2 className="h-4 w-4 animate-spin" />
								Saving...
							</>
						) : (
							<>
								<Clock className="h-4 w-4" />
								{existingSchedule ? "Update Schedule" : "Create Schedule"}
							</>
						)}
					</Button>
				</div>
			</div>
		</div>
	);
};
