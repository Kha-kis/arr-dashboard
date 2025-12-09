"use client";

import type { ServiceInstanceSummary } from "@arr/shared";
import { Check, Pencil, Power, Star, Trash2, Zap } from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Alert, AlertDescription } from "../../../components/ui";
import { useIncognitoMode, getLinuxUrl } from "../../../lib/incognito";
import { cn } from "../../../lib/utils";

/**
 * Props for the ServiceInstanceCard component
 */
interface ServiceInstanceCardProps {
	/** The service instance to display */
	instance: ServiceInstanceSummary;
	/** Handler for test connection button */
	onTestConnection: (instance: ServiceInstanceSummary) => void;
	/** Handler for edit button */
	onEdit: (instance: ServiceInstanceSummary) => void;
	/** Handler for toggle default button */
	onToggleDefault: (instance: ServiceInstanceSummary) => void;
	/** Handler for toggle enabled button */
	onToggleEnabled: (instance: ServiceInstanceSummary) => void;
	/** Handler for delete button */
	onDelete: (instance: ServiceInstanceSummary) => void;
	/** Whether the connection test is currently running for this instance */
	isTesting: boolean;
	/** Whether mutations are pending */
	mutationPending: boolean;
	/** Test result to display (if any) */
	testResult?: {
		id: string;
		success: boolean;
		message: string;
	} | null;
}

/**
 * Displays a single service instance card with action buttons
 */
export const ServiceInstanceCard = ({
	instance,
	onTestConnection,
	onEdit,
	onToggleDefault,
	onToggleEnabled,
	onDelete,
	isTesting,
	mutationPending,
	testResult,
}: ServiceInstanceCardProps) => {
	const [incognitoMode] = useIncognitoMode();
	const displayUrl = incognitoMode ? getLinuxUrl(instance.baseUrl) : instance.baseUrl;

	// Service type colors
	const serviceColors: Record<string, string> = {
		sonarr: "bg-sky-500/20 text-sky-300 border-sky-500/30",
		radarr: "bg-amber-500/20 text-amber-300 border-amber-500/30",
		prowlarr: "bg-purple-500/20 text-purple-300 border-purple-500/30",
	};
	const serviceColor = serviceColors[instance.service.toLowerCase()] ?? "bg-white/10 text-fg-muted border-white/20";

	return (
		<div
			className={cn(
				"rounded-xl border p-4 transition-all",
				instance.enabled
					? "border-border bg-bg-subtle"
					: "border-border/50 bg-bg-subtle/50 opacity-60",
			)}
		>
			{/* Header row */}
			<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				{/* Left: Instance info */}
				<div className="min-w-0 flex-1 space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<span className={cn("rounded-md border px-2 py-0.5 text-xs font-medium uppercase", serviceColor)}>
							{instance.service}
						</span>
						<h3 className="text-base font-semibold text-fg">{instance.label}</h3>
						{instance.isDefault && (
							<span className="inline-flex items-center gap-1 rounded-full bg-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
								<Star className="h-3 w-3" />
								Default
							</span>
						)}
						{!instance.enabled && (
							<span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-fg-muted">
								Disabled
							</span>
						)}
					</div>
					<p className="truncate text-sm text-fg-muted">{displayUrl}</p>
					{instance.tags.length > 0 && (
						<div className="flex flex-wrap gap-1.5">
							{instance.tags.map((tag) => (
								<span
									key={tag.id}
									className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-fg-muted"
								>
									{tag.name}
								</span>
							))}
						</div>
					)}
				</div>

				{/* Right: Action buttons */}
				<div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:gap-2">
					<Button
						variant="secondary"
						size="sm"
						onClick={() => onTestConnection(instance)}
						disabled={isTesting}
						className="gap-1.5"
					>
						<Zap className="h-3.5 w-3.5" />
						{isTesting ? "Testing..." : "Test"}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onEdit(instance)}
						className="gap-1.5"
					>
						<Pencil className="h-3.5 w-3.5" />
						<span className="hidden sm:inline">Edit</span>
					</Button>
					{!instance.isDefault && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onToggleDefault(instance)}
							disabled={mutationPending}
							className="gap-1.5"
						>
							<Star className="h-3.5 w-3.5" />
							<span className="hidden sm:inline">Set default</span>
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onToggleEnabled(instance)}
						disabled={mutationPending}
						className="gap-1.5"
					>
						<Power className="h-3.5 w-3.5" />
						<span className="hidden sm:inline">{instance.enabled ? "Disable" : "Enable"}</span>
					</Button>
					<Button
						variant="danger"
						size="sm"
						onClick={() => onDelete(instance)}
						disabled={mutationPending}
						className="gap-1.5"
					>
						<Trash2 className="h-3.5 w-3.5" />
						<span className="hidden sm:inline">Delete</span>
					</Button>
				</div>
			</div>

			{/* Test result alert */}
			{testResult && testResult.id === instance.id && (
				<Alert variant={testResult.success ? "success" : "danger"} className="mt-3">
					<AlertDescription className="flex items-center gap-2">
						{testResult.success && <Check className="h-4 w-4" />}
						{testResult.message}
					</AlertDescription>
				</Alert>
			)}
		</div>
	);
};
