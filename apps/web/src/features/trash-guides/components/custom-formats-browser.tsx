"use client";

import { useState, useMemo } from "react";
import {
	toast,
} from "../../../components/ui";
import { PremiumSkeleton } from "../../../components/layout";
import {
	Search,
	Package,
	Download,
	CheckCircle2,
	XCircle,
	Loader2,
	Info,
	AlertCircle,
	Palette,
	Filter,
	CheckSquare,
	Square,
	ChevronDown,
	X,
} from "lucide-react";
import { createSanitizedHtml } from "../../../lib/sanitize-html";
import { useCustomFormats, useCFDescriptions, useCFIncludes, useDeployMultipleCustomFormats } from "../hooks/use-custom-formats";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import type { CustomFormat } from "../../../lib/api-client/custom-formats";
import { cleanDescription, markdownToFormattedHtml, resolveIncludes, buildIncludesMap } from "../lib/description-utils";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";

/**
 * Service-specific colors for Radarr/Sonarr identification
 * Using centralized SERVICE_GRADIENTS
 */
const SERVICE_COLORS = {
	RADARR: SERVICE_GRADIENTS.radarr,
	SONARR: SERVICE_GRADIENTS.sonarr,
};

/**
 * Premium Service Badge
 */
const ServiceBadge = ({ service }: { service: "RADARR" | "SONARR" }) => {
	const colors = SERVICE_COLORS[service];
	return (
		<span
			className="inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-medium"
			style={{
				backgroundColor: `${colors.from}20`,
				border: `1px solid ${colors.from}40`,
				color: colors.from,
			}}
		>
			{service}
		</span>
	);
};

/**
 * Premium Custom Format Card
 */
const CustomFormatCard = ({
	format,
	isSelected,
	description,
	onToggle,
	onViewDetails,
	index,
}: {
	format: CustomFormat & { service: "RADARR" | "SONARR" };
	isSelected: boolean;
	description?: string;
	onToggle: () => void;
	onViewDetails: () => void;
	index: number;
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const serviceColors = SERVICE_COLORS[format.service];

	return (
		<article
			className="group relative rounded-2xl border transition-all duration-300 cursor-pointer overflow-hidden animate-in fade-in slide-in-from-bottom-2"
			style={{
				backgroundColor: isSelected ? `${themeGradient.from}10` : "rgba(var(--card), 0.3)",
				borderColor: isSelected ? themeGradient.from : "rgba(var(--border), 0.5)",
				boxShadow: isSelected ? `0 0 20px -5px ${themeGradient.glow}` : undefined,
				animationDelay: `${index * 30}ms`,
				animationFillMode: "backwards",
			}}
			role="button"
			tabIndex={0}
			onClick={onToggle}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onToggle();
				}
			}}
			aria-pressed={isSelected}
			aria-label={`${isSelected ? "Deselect" : "Select"} custom format: ${format.name}`}
		>
			{/* Selection indicator bar */}
			{isSelected && (
				<div
					className="absolute top-0 left-0 right-0 h-1"
					style={{
						background: `linear-gradient(90deg, ${themeGradient.from}, ${themeGradient.to})`,
					}}
				/>
			)}

			<div className="p-5">
				{/* Header */}
				<div className="flex items-start justify-between gap-3 mb-3">
					<div className="flex items-center gap-3 min-w-0 flex-1">
						<div
							className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0 transition-all duration-300"
							style={{
								background: isSelected
									? `linear-gradient(135deg, ${themeGradient.from}30, ${themeGradient.to}30)`
									: `${serviceColors.from}15`,
								border: `1px solid ${isSelected ? themeGradient.from : serviceColors.from}30`,
							}}
						>
							<Palette
								className="h-5 w-5"
								style={{ color: isSelected ? themeGradient.from : serviceColors.from }}
							/>
						</div>
						<div className="min-w-0">
							<h3 className="font-semibold text-foreground truncate">{format.name}</h3>
							<ServiceBadge service={format.service} />
						</div>
					</div>

					{/* Selection checkbox */}
					<div
						className="flex h-6 w-6 items-center justify-center rounded-lg transition-all duration-200 shrink-0"
						style={{
							backgroundColor: isSelected ? themeGradient.from : "rgba(var(--muted), 0.3)",
							border: `1px solid ${isSelected ? themeGradient.from : "rgba(var(--border), 0.5)"}`,
						}}
					>
						{isSelected ? (
							<CheckCircle2 className="h-4 w-4 text-white" />
						) : (
							<div className="h-3 w-3 rounded-sm bg-muted-foreground/20" />
						)}
					</div>
				</div>

				{/* Description */}
				{description && (
					<p className="text-sm text-muted-foreground line-clamp-2 mb-3">
						{description}
					</p>
				)}

				{/* Metadata */}
				<div className="flex items-center justify-between text-xs text-muted-foreground mb-4">
					<span className="flex items-center gap-1.5">
						<Filter className="h-3 w-3" />
						{format.specifications.length} conditions
					</span>
				</div>

				{/* View Details Button */}
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onViewDetails();
					}}
					className="w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200 border border-border/50 bg-card/50 hover:bg-card/80 text-foreground"
				>
					<Info className="h-4 w-4" />
					View Details
				</button>
			</div>
		</article>
	);
};

/**
 * Renders sanitized HTML description content.
 * Uses createSanitizedHtml which sanitizes via DOMPurify to prevent XSS.
 */
const SanitizedDescription = ({ html }: { html: string }) => {
	// Content is sanitized via createSanitizedHtml which uses DOMPurify
	const sanitizedContent = createSanitizedHtml(html);
	return (
		<div
			className="rounded-xl border border-border/50 bg-card/30 p-4 text-sm text-muted-foreground prose prose-invert prose-sm max-w-none"
			dangerouslySetInnerHTML={sanitizedContent}
		/>
	);
};

/**
 * Premium Custom Formats Browser Component
 *
 * Features:
 * - Glassmorphic card design
 * - Theme-aware selection states
 * - Service-specific accent colors
 * - Staggered card animations
 * - Premium deploy modal
 */
export const CustomFormatsBrowser = () => {
	const { gradient: themeGradient } = useThemeGradient();

	const [selectedService, setSelectedService] = useState<"RADARR" | "SONARR" | "ALL">("ALL");
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedFormats, setSelectedFormats] = useState<Set<string>>(new Set());
	const [deployDialogOpen, setDeployDialogOpen] = useState(false);
	const [selectedInstance, setSelectedInstance] = useState("");
	const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
	const [selectedFormatForDetails, setSelectedFormatForDetails] = useState<(CustomFormat & { service: "RADARR" | "SONARR" }) | null>(null);

	// Fetch custom formats
	const { data: customFormatsData, isLoading, error } = useCustomFormats(
		selectedService === "ALL" ? undefined : selectedService
	);

	// Fetch CF descriptions
	const { data: cfDescriptionsData } = useCFDescriptions(
		selectedService === "ALL" ? undefined : selectedService
	);

	// Fetch CF includes (shared snippets for description resolution)
	const { data: cfIncludesData } = useCFIncludes();

	// Build includes map for efficient lookup
	const includesMap = useMemo(() => {
		if (!cfIncludesData || cfIncludesData.length === 0) return new Map();
		return buildIncludesMap(cfIncludesData);
	}, [cfIncludesData]);

	// Fetch instances
	const { data: instances } = useServicesQuery();

	// Deploy mutation
	const deployMutation = useDeployMultipleCustomFormats();

	// Combine and filter custom formats
	const customFormats = useMemo(() => {
		if (!customFormatsData) return [];

		const formats: Array<CustomFormat & { service: "RADARR" | "SONARR" }> = [];

		if (customFormatsData.radarr) {
			formats.push(...customFormatsData.radarr.map(cf => ({ ...cf, service: "RADARR" as const })));
		}

		if (customFormatsData.sonarr) {
			formats.push(...customFormatsData.sonarr.map(cf => ({ ...cf, service: "SONARR" as const })));
		}

		// Filter by search query
		if (searchQuery) {
			return formats.filter(cf =>
				cf.name.toLowerCase().includes(searchQuery.toLowerCase())
			);
		}

		return formats;
	}, [customFormatsData, searchQuery]);

	// Get available instances for selected service
	const availableInstances = useMemo(() => {
		if (!instances) return [];

		const selectedFormatsArray = Array.from(selectedFormats);
		if (selectedFormatsArray.length === 0) return [];

		const selectedServicesSet = new Set(
			selectedFormatsArray.map(selectionKey => {
				const [service] = selectionKey.split('-');
				return service;
			})
		);

		if (selectedServicesSet.size > 1) {
			return [];
		}

		const service = Array.from(selectedServicesSet)[0];
		return instances.filter(inst => inst.service.toUpperCase() === service);
	}, [instances, selectedFormats]);

	// Helper to create combined selection key
	const getSelectionKey = (format: { service: string; trash_id: string }) =>
		`${format.service}-${format.trash_id}`;

	// Handle format selection
	const toggleFormat = (selectionKey: string) => {
		const newSelection = new Set(selectedFormats);
		if (newSelection.has(selectionKey)) {
			newSelection.delete(selectionKey);
		} else {
			newSelection.add(selectionKey);
		}
		setSelectedFormats(newSelection);
	};

	// Handle select all
	const handleSelectAll = () => {
		if (selectedFormats.size === customFormats.length) {
			setSelectedFormats(new Set());
		} else {
			setSelectedFormats(new Set(customFormats.map(cf => getSelectionKey(cf))));
		}
	};

	// Get description for a custom format using multiple matching strategies
	const getDescription = (format: CustomFormat & { service: "RADARR" | "SONARR" }) => {
		const service = format.service.toLowerCase() as "radarr" | "sonarr";
		const descriptions = cfDescriptionsData?.[service] || [];
		const name = format.name;
		const nameLower = name.toLowerCase();
		const slug = nameLower.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

		// Strategy 1: Exact slug match on cfName (file name)
		let match = descriptions.find(d => d.cfName === slug);

		// Strategy 2: Match displayName case-insensitively
		if (!match) {
			match = descriptions.find(d => d.displayName.toLowerCase() === nameLower);
		}

		// Strategy 3: Base name without parenthetical suffix (e.g., "ATMOS (undefined)" → "atmos")
		if (!match) {
			const baseName = nameLower.replace(/\s*\([^)]*\)\s*$/, '').trim();
			const baseSlug = baseName.replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
			if (baseSlug !== slug) {
				match = descriptions.find(d => d.cfName === baseSlug);
			}

			// Strategy 4: Partial displayName match (displayName starts with CF name)
			if (!match) {
				match = descriptions.find(d => d.displayName.toLowerCase().startsWith(baseName));
			}
		}

		// Return cleaned description string for card display
		if (match?.rawMarkdown) {
			return cleanDescription(match.rawMarkdown, format.name);
		}

		return undefined;
	};

	// Handle view details
	const handleViewDetails = (format: CustomFormat & { service: "RADARR" | "SONARR" }) => {
		setSelectedFormatForDetails(format);
		setDetailsDialogOpen(true);
	};

	// Handle deploy
	const handleDeploy = () => {
		if (selectedFormats.size === 0) {
			toast.error("Please select at least one custom format");
			return;
		}
		setDeployDialogOpen(true);
	};

	const handleConfirmDeploy = async () => {
		if (!selectedInstance) {
			toast.error("Please select an instance");
			return;
		}

		const instance = instances?.find(inst => inst.id === selectedInstance);
		if (!instance) {
			toast.error("Instance not found");
			return;
		}

		try {
			const trashIds = Array.from(selectedFormats).map(selectionKey => {
				const firstHyphenIndex = selectionKey.indexOf('-');
				return selectionKey.slice(firstHyphenIndex + 1);
			});

			const result = await deployMutation.mutateAsync({
				trashIds,
				instanceId: selectedInstance,
				serviceType: instance.service.toUpperCase() as "RADARR" | "SONARR",
			});

			if (result.success) {
				toast.success(
					`Successfully deployed ${result.created.length + result.updated.length} custom formats`
				);
				setSelectedFormats(new Set());
				setDeployDialogOpen(false);
				setSelectedInstance("");
			} else {
				toast.error(
					`Deployed with errors: ${result.failed.length} failed`
				);
			}
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to deploy custom formats"
			);
		}
	};

	// Loading State
	if (isLoading) {
		return (
			<div className="space-y-6 animate-in fade-in duration-300">
				{/* Header Skeleton */}
				<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-6">
					<div className="space-y-4">
						<div className="flex items-center gap-4">
							<PremiumSkeleton variant="card" className="h-12 w-12 rounded-xl" />
							<div className="space-y-2 flex-1">
								<PremiumSkeleton variant="line" className="h-6 w-48" style={{ animationDelay: "50ms" }} />
								<PremiumSkeleton variant="line" className="h-4 w-96" style={{ animationDelay: "100ms" }} />
							</div>
						</div>
						<div className="flex gap-4">
							<PremiumSkeleton variant="card" className="h-10 w-40 rounded-xl" style={{ animationDelay: "150ms" }} />
							<PremiumSkeleton variant="card" className="h-10 flex-1 rounded-xl" style={{ animationDelay: "200ms" }} />
							<PremiumSkeleton variant="card" className="h-10 w-32 rounded-xl" style={{ animationDelay: "250ms" }} />
						</div>
					</div>
				</div>
				{/* Cards Skeleton */}
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{Array.from({ length: 6 }).map((_, i) => (
						<PremiumSkeleton key={i} variant="card" className="h-56 rounded-2xl" style={{ animationDelay: `${(i + 6) * 50}ms` }} />
					))}
				</div>
			</div>
		);
	}

	// Error State
	if (error) {
		return (
			<div
				className="rounded-2xl border p-6 backdrop-blur-xs"
				style={{
					backgroundColor: SEMANTIC_COLORS.error.bg,
					borderColor: SEMANTIC_COLORS.error.border,
				}}
			>
				<div className="flex items-start gap-4">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
						style={{ backgroundColor: `${SEMANTIC_COLORS.error.from}20` }}
					>
						<XCircle className="h-5 w-5" style={{ color: SEMANTIC_COLORS.error.from }} />
					</div>
					<div>
						<h3 className="font-semibold text-foreground mb-1">Failed to load custom formats</h3>
						<p className="text-sm text-muted-foreground">
							{error instanceof Error ? error.message : "Please refresh the page and try again."}
						</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6 animate-in fade-in duration-300">
			{/* Header and Controls */}
			<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs p-6">
				<div className="space-y-5">
					{/* Title */}
					<div className="flex items-center gap-4">
						<div
							className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<Palette className="h-6 w-6" style={{ color: themeGradient.from }} />
						</div>
						<div>
							<h3
								className="text-lg font-bold"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									WebkitBackgroundClip: "text",
									WebkitTextFillColor: "transparent",
								}}
							>
								Browse Custom Formats
							</h3>
							<p className="text-sm text-muted-foreground">
								Browse and deploy individual TRaSH Guides custom formats directly to your instances
							</p>
						</div>
					</div>

					{/* Controls */}
					<div className="flex flex-wrap gap-3 items-center">
						{/* Service Type Filter */}
						<div className="relative">
							<select
								value={selectedService}
								onChange={(e) => {
									setSelectedService(e.target.value as "RADARR" | "SONARR" | "ALL");
									setSelectedFormats(new Set());
								}}
								className="appearance-none rounded-xl border border-border/50 bg-card/50 px-4 py-2.5 pr-10 text-sm font-medium text-foreground focus:outline-hidden focus:ring-2 transition-all"
								style={{ ["--tw-ring-color" as string]: themeGradient.from }}
							>
								<option value="ALL">All Services</option>
								<option value="RADARR">Radarr</option>
								<option value="SONARR">Sonarr</option>
							</select>
							<ChevronDown className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
						</div>

						{/* Search */}
						<div className="relative flex-1 min-w-[200px]">
							<Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
							<input
								type="text"
								placeholder="Search custom formats..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="w-full rounded-xl border border-border/50 bg-card/50 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 transition-all"
								style={{ ["--tw-ring-color" as string]: themeGradient.from, paddingLeft: "2.5rem" }}
							/>
						</div>

						{/* Selection Actions */}
						<div className="flex gap-2">
							<button
								type="button"
								onClick={handleSelectAll}
								className="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all duration-200 border border-border/50 bg-card/50 hover:bg-card/80 text-foreground"
							>
								{selectedFormats.size === customFormats.length ? (
									<>
										<CheckSquare className="h-4 w-4" style={{ color: themeGradient.from }} />
										Deselect All
									</>
								) : (
									<>
										<Square className="h-4 w-4" />
										Select All
									</>
								)}
							</button>

							<button
								type="button"
								onClick={handleDeploy}
								disabled={selectedFormats.size === 0}
								className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
								style={{
									background: selectedFormats.size > 0
										? `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`
										: "rgba(var(--muted), 0.5)",
									boxShadow: selectedFormats.size > 0 ? `0 4px 12px -4px ${themeGradient.glow}` : undefined,
								}}
							>
								<Download className="h-4 w-4" />
								Deploy Selected ({selectedFormats.size})
							</button>
						</div>
					</div>
				</div>
			</div>

			{/* Custom Formats Grid */}
			{customFormats.length === 0 ? (
				<div className="rounded-2xl border border-dashed border-border/50 bg-card/20 backdrop-blur-xs p-12 text-center">
					<Package className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
					<p className="text-lg font-medium text-foreground mb-2">No custom formats found</p>
					<p className="text-sm text-muted-foreground">
						{searchQuery
							? "Try adjusting your search query"
							: "No custom formats available for the selected service"}
					</p>
				</div>
			) : (
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{customFormats.map((format, index) => {
						const selectionKey = getSelectionKey(format);
						return (
							<CustomFormatCard
								key={selectionKey}
								format={format}
								isSelected={selectedFormats.has(selectionKey)}
								description={getDescription(format)}
								onToggle={() => toggleFormat(selectionKey)}
								onViewDetails={() => handleViewDetails(format)}
								index={index}
							/>
						);
					})}
				</div>
			)}

			{/* Deploy Dialog */}
			{deployDialogOpen && (
				<div
					className="fixed inset-0 z-modal flex items-center justify-center"
					role="dialog"
					aria-modal="true"
					aria-labelledby="deploy-cf-title"
				>
					{/* Backdrop */}
					<div
						className="absolute inset-0 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200"
						onClick={() => !deployMutation.isPending && setDeployDialogOpen(false)}
					/>

					{/* Modal */}
					<div
						className="relative z-10 w-full max-w-md mx-4 rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl p-6 shadow-2xl animate-in zoom-in-95 fade-in duration-200"
						style={{ boxShadow: `0 25px 50px -12px ${themeGradient.glow}` }}
					>
						{/* Header */}
						<div className="flex items-center justify-between mb-6">
							<div className="flex items-center gap-3">
								<div
									className="flex h-10 w-10 items-center justify-center rounded-xl"
									style={{
										background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
										border: `1px solid ${themeGradient.from}30`,
									}}
								>
									<Download className="h-5 w-5" style={{ color: themeGradient.from }} />
								</div>
								<div>
									<h3 id="deploy-cf-title" className="text-lg font-bold text-foreground">Deploy Custom Formats</h3>
									<p className="text-sm text-muted-foreground">
										{selectedFormats.size} format{selectedFormats.size !== 1 ? "s" : ""} selected
									</p>
								</div>
							</div>
							<button
								type="button"
								onClick={() => setDeployDialogOpen(false)}
								disabled={deployMutation.isPending}
								aria-label="Close deploy dialog"
								className="rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-card/80 transition-colors disabled:opacity-50"
							>
								<X className="h-5 w-5" />
							</button>
						</div>

						{/* Content */}
						<div className="space-y-4 mb-6">
							{!instances || instances.length === 0 ? (
								<div
									className="rounded-xl p-4"
									style={{
										backgroundColor: SEMANTIC_COLORS.warning.bg,
										border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
									}}
								>
									<div className="flex items-start gap-3">
										<AlertCircle className="h-5 w-5 mt-0.5" style={{ color: SEMANTIC_COLORS.warning.from }} />
										<div>
											<p className="font-medium text-foreground">No instances configured</p>
											<p className="text-sm text-muted-foreground mt-1">
												Configure at least one Radarr or Sonarr instance in Settings first.
											</p>
										</div>
									</div>
								</div>
							) : availableInstances.length === 0 ? (
								<div
									className="rounded-xl p-4"
									style={{
										backgroundColor: SEMANTIC_COLORS.warning.bg,
										border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
									}}
								>
									<div className="flex items-start gap-3">
										<AlertCircle className="h-5 w-5 mt-0.5" style={{ color: SEMANTIC_COLORS.warning.from }} />
										<div>
											<p className="font-medium text-foreground">No compatible instances</p>
											<p className="text-sm text-muted-foreground mt-1">
												Selected formats are from different services. Please select formats from only one service type.
											</p>
										</div>
									</div>
								</div>
							) : (
								<div className="space-y-2">
									<label className="text-sm font-medium text-foreground">Select Instance</label>
									<div className="relative">
										<select
											value={selectedInstance}
											onChange={(e) => setSelectedInstance(e.target.value)}
											className="w-full appearance-none rounded-xl border border-border/50 bg-card/50 px-4 py-3 pr-10 text-sm text-foreground focus:outline-hidden focus:ring-2 transition-all"
											style={{ ["--tw-ring-color" as string]: themeGradient.from }}
										>
											<option value="">Choose an instance...</option>
											{availableInstances.map((instance) => (
												<option key={instance.id} value={instance.id}>
													{instance.label} ({instance.service})
												</option>
											))}
										</select>
										<ChevronDown className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
									</div>
								</div>
							)}
						</div>

						{/* Footer */}
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setDeployDialogOpen(false)}
								disabled={deployMutation.isPending}
								className="rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleConfirmDeploy}
								disabled={!selectedInstance || availableInstances.length === 0 || deployMutation.isPending}
								className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium text-white transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
								}}
							>
								{deployMutation.isPending ? (
									<>
										<Loader2 className="h-4 w-4 animate-spin" />
										Deploying...
									</>
								) : (
									<>
										<Download className="h-4 w-4" />
										Deploy
									</>
								)}
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Details Dialog */}
			{detailsDialogOpen && selectedFormatForDetails && (
				<div
					className="fixed inset-0 z-modal flex items-center justify-center"
					role="dialog"
					aria-modal="true"
					aria-labelledby="cf-details-title"
				>
					{/* Backdrop */}
					<div
						className="absolute inset-0 bg-black/60 backdrop-blur-xs animate-in fade-in duration-200"
						onClick={() => setDetailsDialogOpen(false)}
					/>

					{/* Modal */}
					<div
						className="relative z-10 w-full max-w-3xl max-h-[80vh] mx-4 rounded-2xl border border-border/50 bg-card/95 backdrop-blur-xl shadow-2xl animate-in zoom-in-95 fade-in duration-200 overflow-hidden"
						style={{ boxShadow: `0 25px 50px -12px ${themeGradient.glow}` }}
					>
						{/* Header */}
						<div className="sticky top-0 z-10 flex items-center justify-between p-6 border-b border-border/50 bg-card/95 backdrop-blur-xl">
							<div className="flex items-center gap-3">
								<div
									className="flex h-10 w-10 items-center justify-center rounded-xl"
									style={{
										background: `${SERVICE_COLORS[selectedFormatForDetails.service].from}20`,
										border: `1px solid ${SERVICE_COLORS[selectedFormatForDetails.service].from}40`,
									}}
								>
									<Palette className="h-5 w-5" style={{ color: SERVICE_COLORS[selectedFormatForDetails.service].from }} />
								</div>
								<div>
									<h3 id="cf-details-title" className="text-lg font-bold text-foreground">{selectedFormatForDetails.name}</h3>
									<ServiceBadge service={selectedFormatForDetails.service} />
								</div>
							</div>
							<button
								type="button"
								onClick={() => setDetailsDialogOpen(false)}
								aria-label="Close details dialog"
								className="rounded-lg p-2 text-muted-foreground hover:text-foreground hover:bg-card/80 transition-colors"
							>
								<X className="h-5 w-5" />
							</button>
						</div>

						{/* Content */}
						<div className="p-6 overflow-y-auto max-h-[calc(80vh-80px)]">
							{(() => {
								const service = selectedFormatForDetails.service.toLowerCase() as "radarr" | "sonarr";
								const descriptions = cfDescriptionsData?.[service] || [];
								const slug = selectedFormatForDetails.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
								const description = descriptions.find(d => d.cfName === slug);

								return (
									<div className="space-y-6">
										{/* Description */}
										{description && (
											<div className="space-y-3">
												<h4 className="text-sm font-semibold text-foreground">Description</h4>
												<SanitizedDescription html={description.description} />
											</div>
										)}

										{/* Metadata */}
										<div className="space-y-3">
											<h4 className="text-sm font-semibold text-foreground">Information</h4>
											<div className="rounded-xl border border-border/50 bg-card/30 p-4 space-y-3 text-sm">
												<div className="flex justify-between items-center">
													<span className="text-muted-foreground">TRaSH ID:</span>
													<span className="font-mono text-xs text-foreground bg-muted/30 px-2 py-1 rounded">
														{selectedFormatForDetails.trash_id}
													</span>
												</div>
												<div className="flex justify-between items-center">
													<span className="text-muted-foreground">Conditions:</span>
													<span className="text-foreground font-medium">
														{selectedFormatForDetails.specifications.length}
													</span>
												</div>
											</div>
										</div>

										{/* Specifications/Conditions */}
										<div className="space-y-3">
											<h4 className="text-sm font-semibold text-foreground">Conditions</h4>
											<div className="space-y-2">
												{selectedFormatForDetails.specifications.map((spec, index) => (
													<div
														key={index}
														className="rounded-xl border border-border/50 bg-card/30 p-4 animate-in fade-in"
														style={{
															animationDelay: `${index * 30}ms`,
															animationFillMode: "backwards",
														}}
													>
														<div className="flex items-start justify-between mb-2">
															<div className="flex-1">
																<div className="font-medium text-foreground">{spec.name}</div>
																<div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
																	<span>{spec.implementation}</span>
																	{spec.negate && (
																		<span
																			className="px-2 py-0.5 rounded"
																			style={{
																				backgroundColor: SEMANTIC_COLORS.warning.bg,
																				border: `1px solid ${SEMANTIC_COLORS.warning.border}`,
																				color: SEMANTIC_COLORS.warning.text,
																			}}
																		>
																			Negated
																		</span>
																	)}
																	{spec.required && (
																		<span
																			className="px-2 py-0.5 rounded"
																			style={{
																				backgroundColor: `${themeGradient.from}20`,
																				border: `1px solid ${themeGradient.from}40`,
																				color: themeGradient.from,
																			}}
																		>
																			Required
																		</span>
																	)}
																</div>
															</div>
														</div>
														{spec.fields && Object.keys(spec.fields).length > 0 && (
															<div className="mt-3 space-y-1.5 pt-3 border-t border-border/30">
																{Object.entries(spec.fields).map(([key, value]) => (
																	<div key={key} className="text-xs flex items-start gap-2">
																		<span className="text-muted-foreground shrink-0">{key}:</span>
																		<span className="font-mono text-foreground/80 break-all">
																			{typeof value === 'object' ? JSON.stringify(value) : String(value)}
																		</span>
																	</div>
																))}
															</div>
														)}
													</div>
												))}
											</div>
										</div>
									</div>
								);
							})()}
						</div>
					</div>
				</div>
			)}
		</div>
	);
};
