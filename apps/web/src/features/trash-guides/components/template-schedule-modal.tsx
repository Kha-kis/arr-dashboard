"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Button, Input, Select, SelectOption, Alert } from "../../../components/ui";
import { Clock, X, Calendar, AlertCircle } from "lucide-react";

interface TemplateScheduleModalProps {
	open: boolean;
	onClose: () => void;
	templateId: string;
	templateName: string;
	instanceId: string;
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

export const TemplateScheduleModal = ({
	open,
	onClose,
	templateId,
	templateName,
	instanceId,
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

	const modalRef = useRef<HTMLDivElement>(null);
	const previousActiveElement = useRef<HTMLElement | null>(null);

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
			// Restore focus when modal closes
			previousActiveElement.current?.focus();
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
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
			<div
				ref={modalRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="schedule-modal-title"
				tabIndex={-1}
				className="relative w-full max-w-2xl overflow-hidden rounded-xl border border-white/10 bg-slate-900 shadow-xl"
			>
				{/* Header */}
				<div className="flex items-center justify-between border-b border-white/10 bg-slate-900/95 p-6 backdrop-blur">
					<div>
						<h2 id="schedule-modal-title" className="text-xl font-semibold text-white flex items-center gap-2">
							<Clock className="h-5 w-5 text-primary" />
							{existingSchedule ? "Edit Sync Schedule" : "Create Sync Schedule"}
						</h2>
						<p className="mt-1 text-sm text-white/60">
							Automatically sync "{templateName}" to {instanceName}
						</p>
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close dialog"
						className="rounded p-1 text-white/60 hover:bg-white/10 hover:text-white"
					>
						<X className="h-5 w-5" />
					</button>
				</div>

				{/* Content */}
				<div className="p-6 space-y-6">
					{/* Error Alert */}
					{error && (
						<Alert variant="danger" className="flex items-start gap-2">
							<AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
							<div>
								<p className="font-medium">Error</p>
								<p className="text-sm">{error}</p>
							</div>
						</Alert>
					)}

					{/* Frequency */}
					<div>
						<label className="mb-2 block text-sm font-medium text-white">
							Sync Frequency
						</label>
						<Select
							value={frequency}
							onChange={(e) => setFrequency(e.target.value as "DAILY" | "WEEKLY" | "MONTHLY")}
							className="w-full"
						>
							<SelectOption value="DAILY">Daily</SelectOption>
							<SelectOption value="WEEKLY">Weekly</SelectOption>
							<SelectOption value="MONTHLY">Monthly</SelectOption>
						</Select>
						<p className="mt-1 text-xs text-white/60">
							How often the template should sync to this instance
						</p>
					</div>

					{/* Options */}
					<div className="space-y-4 rounded-lg border border-white/10 bg-white/5 p-4">
						<h3 className="text-sm font-medium text-white">Sync Options</h3>

						{/* Enabled */}
						<label className="flex items-start gap-3 cursor-pointer">
							<input
								type="checkbox"
								checked={enabled}
								onChange={(e) => setEnabled(e.target.checked)}
								className="mt-1 h-4 w-4 rounded border-white/20 bg-white/10 text-primary focus:ring-2 focus:ring-primary/20"
							/>
							<div className="flex-1">
								<span className="text-sm font-medium text-white">Enable Schedule</span>
								<p className="text-xs text-white/60 mt-0.5">
									Turn this schedule on or off without deleting it
								</p>
							</div>
						</label>

						{/* Auto Apply */}
						<label className="flex items-start gap-3 cursor-pointer">
							<input
								type="checkbox"
								checked={autoApply}
								onChange={(e) => setAutoApply(e.target.checked)}
								className="mt-1 h-4 w-4 rounded border-white/20 bg-white/10 text-primary focus:ring-2 focus:ring-primary/20"
							/>
							<div className="flex-1">
								<span className="text-sm font-medium text-white">Auto-Apply Changes</span>
								<p className="text-xs text-white/60 mt-0.5">
									Automatically deploy changes to {instanceName} without manual approval
								</p>
							</div>
						</label>

						{/* Notify */}
						<label className="flex items-start gap-3 cursor-pointer">
							<input
								type="checkbox"
								checked={notifyUser}
								onChange={(e) => setNotifyUser(e.target.checked)}
								className="mt-1 h-4 w-4 rounded border-white/20 bg-white/10 text-primary focus:ring-2 focus:ring-primary/20"
							/>
							<div className="flex-1">
								<span className="text-sm font-medium text-white">Notify on Sync</span>
								<p className="text-xs text-white/60 mt-0.5">
									Get notified when scheduled syncs complete
								</p>
							</div>
						</label>
					</div>

					{/* Info Box */}
					<div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-4">
						<div className="flex gap-2">
							<Calendar className="h-4 w-4 text-blue-400 mt-0.5 flex-shrink-0" />
							<div className="text-sm text-blue-200">
								<p className="font-medium mb-1">How Sync Schedules Work</p>
								<ul className="space-y-1 text-xs text-blue-200/80">
									<li>• Schedule checks for template updates at the specified frequency</li>
									<li>• If updates are found, they're either auto-applied or require approval</li>
									<li>• You can manually sync anytime using the Sync button</li>
								</ul>
							</div>
						</div>
					</div>
				</div>

				{/* Footer */}
				<div className="flex justify-end gap-2 border-t border-white/10 bg-slate-900/95 p-6 backdrop-blur">
					<button
						type="button"
						onClick={onClose}
						className="rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleSave}
						disabled={isSaving}
						className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition hover:bg-primary/90 disabled:opacity-50"
					>
						<Clock className="h-4 w-4" />
						{isSaving ? "Saving..." : existingSchedule ? "Update Schedule" : "Create Schedule"}
					</button>
				</div>
			</div>
		</div>
	);
};
