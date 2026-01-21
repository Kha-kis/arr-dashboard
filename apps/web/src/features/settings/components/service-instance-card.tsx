"use client";

import type { ServiceInstanceSummary } from "@arr/shared";
import {
	Check,
	Pencil,
	Power,
	Star,
	Trash2,
	Zap,
	Loader2,
	AlertCircle,
	ExternalLink,
} from "lucide-react";
import { Button } from "../../../components/ui/button";
import {
	ServiceBadge,
	StatusBadge,
} from "../../../components/layout";
import { getServiceGradient, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
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
	/** Animation delay in ms for staggered entrance */
	animationDelay?: number;
}

/**
 * Premium Service Instance Card
 *
 * Displays a service instance with:
 * - Service-specific gradient accents
 * - Glassmorphic background
 * - Theme-aware action buttons
 * - Staggered entrance animation
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
	animationDelay = 0,
}: ServiceInstanceCardProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	// Use externalUrl for browser navigation if available, otherwise fall back to baseUrl
	const linkUrl = instance.externalUrl || instance.baseUrl;
	const displayUrl = incognitoMode ? getLinuxUrl(linkUrl) : linkUrl;

	// Get service gradient for accent
	const serviceGradient = getServiceGradient(instance.service);

	// Check if this card has test results
	const hasTestResult = testResult && testResult.id === instance.id;
	const testSuccess = hasTestResult && testResult.success;
	const testFailed = hasTestResult && !testResult.success;

	return (
		<div
			className={cn(
				"group relative rounded-2xl border overflow-hidden transition-all duration-300",
				"animate-in fade-in slide-in-from-bottom-2",
				instance.enabled
					? "border-border/50 bg-card/30 backdrop-blur-xs hover:border-border/80"
					: "border-border/30 bg-card/20 opacity-60"
			)}
			style={{
				animationDelay: `${animationDelay}ms`,
				animationFillMode: "backwards",
			}}
		>
			{/* Service gradient accent line at top */}
			<div
				className="absolute top-0 left-0 right-0 h-0.5"
				style={{
					background: `linear-gradient(90deg, ${serviceGradient.from}, ${serviceGradient.to})`,
					opacity: instance.enabled ? 1 : 0.5,
				}}
			/>

			<div className="p-4">
				{/* Header row */}
				<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
					{/* Left: Instance info */}
					<div className="min-w-0 flex-1 space-y-2">
						<div className="flex flex-wrap items-center gap-2">
							<ServiceBadge service={instance.service} />
							<h3 className="text-base font-semibold text-foreground">{instance.label}</h3>
							{instance.isDefault && (
								<div
									className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
									style={{
										backgroundColor: themeGradient.fromLight,
										color: themeGradient.from,
										border: `1px solid ${themeGradient.fromMuted}`,
									}}
								>
									<Star className="h-3 w-3" />
									Default
								</div>
							)}
							{!instance.enabled && (
								<StatusBadge status="default">Disabled</StatusBadge>
							)}
						</div>

						{/* URL */}
						<div className="flex items-center gap-2">
							<p className="truncate text-sm text-muted-foreground">{displayUrl}</p>
							<a
								href={linkUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="text-muted-foreground hover:text-foreground transition-colors"
								title="Open in new tab"
							>
								<ExternalLink className="h-3.5 w-3.5" />
							</a>
						</div>

						{/* Tags */}
						{instance.tags.length > 0 && (
							<div className="flex flex-wrap gap-1.5">
								{instance.tags.map((tag) => (
									<span
										key={tag.id}
										className="rounded-full bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground"
									>
										{tag.name}
									</span>
								))}
							</div>
						)}
					</div>

					{/* Right: Action buttons */}
					<div className="flex shrink-0 flex-wrap items-center gap-1.5">
						{/* Test button */}
						<Button
							variant="secondary"
							size="sm"
							onClick={() => onTestConnection(instance)}
							disabled={isTesting}
							className="gap-1.5 border-border/50 bg-card/50 backdrop-blur-xs hover:bg-card/80"
						>
							{isTesting ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Zap className="h-3.5 w-3.5" style={{ color: themeGradient.from }} />
							)}
							{isTesting ? "Testing..." : "Test"}
						</Button>

						{/* Edit button */}
						<Button
							variant="ghost"
							size="sm"
							onClick={() => onEdit(instance)}
							className="gap-1.5"
						>
							<Pencil className="h-3.5 w-3.5" />
							<span className="hidden sm:inline">Edit</span>
						</Button>

						{/* Set Default button */}
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

						{/* Enable/Disable button */}
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

						{/* Delete button */}
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

				{/* Test result */}
				{hasTestResult && (
					<div
						className="mt-4 flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
						style={{
							backgroundColor: testSuccess ? SEMANTIC_COLORS.success.bg : SEMANTIC_COLORS.error.bg,
							border: `1px solid ${testSuccess ? SEMANTIC_COLORS.success.border : SEMANTIC_COLORS.error.border}`,
							color: testSuccess ? SEMANTIC_COLORS.success.text : SEMANTIC_COLORS.error.text,
						}}
					>
						{testSuccess ? (
							<Check className="h-4 w-4 shrink-0" />
						) : (
							<AlertCircle className="h-4 w-4 shrink-0" />
						)}
						<span>{testResult.message}</span>
					</div>
				)}
			</div>
		</div>
	);
};
