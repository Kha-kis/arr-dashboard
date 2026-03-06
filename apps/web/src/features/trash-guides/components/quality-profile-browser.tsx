"use client";

import {
	ChevronDown,
	Download,
	FileText,
	Gauge,
	Languages,
	Search,
	Star,
	X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PremiumSkeleton } from "../../../components/layout/premium-components";
import { Alert, AlertDescription, Button, EmptyState, Input } from "../../../components/ui";
import { useImportQualityProfile, useQualityProfiles } from "../../../hooks/api/useQualityProfiles";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { QualityProfileSummary } from "../../../lib/api-client/trash-guides";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { getErrorMessage } from "../../../lib/error-utils";
import { htmlToPlainText } from "../lib/description-utils";
import { SanitizedHtml } from "./sanitized-html";

// ============================================================================
// BrowserGroupSection sub-component
// ============================================================================

interface BrowserGroupSectionProps {
	groupName: string | null;
	profiles: QualityProfileSummary[];
	onSelect: (profile: QualityProfileSummary) => void;
	defaultExpanded?: boolean;
}

const BrowserGroupSection = ({
	groupName,
	profiles,
	onSelect,
	defaultExpanded = true,
}: BrowserGroupSectionProps) => {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const { gradient } = useThemeGradient();

	const profileGrid = (
		<div className="grid gap-4 md:grid-cols-2">
			{profiles.map((profile, index) => (
				<button
					key={profile.trashId}
					type="button"
					onClick={() => onSelect(profile)}
					className="group relative flex flex-col rounded-xl border border-border bg-card/50 p-6 text-left transition hover:border-primary hover:bg-muted animate-in fade-in slide-in-from-bottom-2 duration-slow"
					style={{ animationDelay: `${index * 30}ms`, animationFillMode: "backwards" }}
				>
					{/* Variable height content */}
					<div className="flex-1 space-y-3">
						<div className="flex items-start justify-between">
							<h3 className="font-medium text-foreground">{profile.name}</h3>
							{profile.scoreSet && (
								<span className="rounded bg-primary/20 px-2 py-1 text-xs text-primary">
									{profile.scoreSet}
								</span>
							)}
						</div>

						{profile.description && (
							<SanitizedHtml
								html={profile.description}
								className="text-sm text-muted-foreground line-clamp-2"
							/>
						)}

						<div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
							<span className="inline-flex items-center gap-1">
								<Star className="h-3 w-3" />
								{profile.customFormatCount} formats
							</span>
							<span className="inline-flex items-center gap-1">
								<Gauge className="h-3 w-3" />
								{profile.qualityCount} qualities
							</span>
							{profile.language && (
								<span className="inline-flex items-center gap-1">
									<Languages className="h-3 w-3" />
									{profile.language}
								</span>
							)}
						</div>
					</div>

					{/* Fixed bottom section */}
					<div className="mt-auto pt-3">
						<div className="flex items-center justify-between text-xs">
							<span className="text-muted-foreground">Cutoff: {profile.cutoff}</span>
							<span
								className={`rounded px-2 py-1 ${
									profile.upgradeAllowed ? "" : "bg-muted text-muted-foreground"
								}`}
								style={
									profile.upgradeAllowed
										? {
												backgroundColor: SEMANTIC_COLORS.success.bg,
												color: SEMANTIC_COLORS.success.text,
											}
										: undefined
								}
							>
								{profile.upgradeAllowed ? "Upgrades On" : "Upgrades Off"}
							</span>
						</div>
					</div>
				</button>
			))}
		</div>
	);

	// No header when groupName is null (flat/search mode)
	if (groupName === null) {
		return profileGrid;
	}

	return (
		<div className="rounded-xl border border-border/40 bg-card/20 backdrop-blur-sm overflow-hidden">
			{/* Group header */}
			<button
				type="button"
				className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-card/40 transition-colors text-left"
				onClick={() => setExpanded((prev) => !prev)}
			>
				<div className="flex items-center gap-3">
					<div
						className="h-1.5 w-1.5 rounded-full flex-shrink-0"
						style={{ backgroundColor: gradient.from }}
					/>
					<span className="font-semibold text-sm text-foreground">{groupName}</span>
					<span
						className="rounded-full px-2 py-0.5 text-xs font-medium"
						style={{
							backgroundColor: gradient.fromLight,
							color: gradient.from,
						}}
					>
						{profiles.length}
					</span>
				</div>
				<ChevronDown
					className="h-4 w-4 text-muted-foreground transition-transform duration-normal flex-shrink-0"
					style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}
				/>
			</button>

			{/* Group body */}
			{expanded && <div className="px-4 pb-4">{profileGrid}</div>}
		</div>
	);
};

// ============================================================================
// Main component
// ============================================================================

interface QualityProfileBrowserProps {
	open: boolean;
	onClose: () => void;
	serviceType: "RADARR" | "SONARR";
}

export const QualityProfileBrowser = ({
	open,
	onClose,
	serviceType,
}: QualityProfileBrowserProps) => {
	const [selectedProfile, setSelectedProfile] = useState<QualityProfileSummary | null>(null);
	const [templateName, setTemplateName] = useState("");
	const [templateDescription, setTemplateDescription] = useState("");
	const [searchQuery, setSearchQuery] = useState("");

	const { data, isLoading, error } = useQualityProfiles(serviceType);
	const importMutation = useImportQualityProfile();

	const handleImport = async () => {
		if (!selectedProfile || !templateName.trim()) {
			return;
		}

		try {
			await importMutation.mutateAsync({
				serviceType,
				trashId: selectedProfile.trashId,
				templateName: templateName.trim(),
				templateDescription: templateDescription.trim() || undefined,
				selectedCFGroups: [],
				customFormatSelections: {},
			});

			// Show success toast before closing
			toast.success(`Successfully imported "${templateName.trim()}" as template!`);

			// Reset state and close
			setSelectedProfile(null);
			setTemplateName("");
			setTemplateDescription("");
			setSearchQuery("");
			onClose();
		} catch (error) {
			// API errors are surfaced via importMutation.isError state in the UI
			console.error("[QualityProfileBrowser] Import failed:", error);
		}
	};

	const handleSelectProfile = (profile: QualityProfileSummary) => {
		setSelectedProfile(profile);
		setTemplateName(profile.name);
		setTemplateDescription(
			profile.description
				? htmlToPlainText(profile.description)
				: `Imported from TRaSH Guides: ${profile.name}`,
		);
	};

	// Compute grouped layout once whenever profiles or search changes
	const groupedProfiles = useMemo(() => {
		if (!data?.profiles) return [];

		const query = searchQuery.trim().toLowerCase();

		// Search mode: flat pseudo-group with no header
		if (query) {
			const filtered = data.profiles.filter(
				(p) =>
					p.name.toLowerCase().includes(query) ||
					(p.description ?? "").toLowerCase().includes(query) ||
					(p.scoreSet ?? "").toLowerCase().includes(query),
			);
			return [{ name: null as string | null, profiles: filtered }];
		}

		// Check whether ANY profile has a groupName assigned
		const hasAnyGroup = data.profiles.some((p) => p.groupName);

		// No groups at all: collapse to flat layout
		if (!hasAnyGroup) {
			return [{ name: null as string | null, profiles: data.profiles }];
		}

		// Build ordered groups preserving first-seen order
		const orderMap = new Map<string, QualityProfileSummary[]>();
		const ungrouped: QualityProfileSummary[] = [];

		for (const profile of data.profiles) {
			if (profile.groupName) {
				const existing = orderMap.get(profile.groupName);
				if (existing) {
					existing.push(profile);
				} else {
					orderMap.set(profile.groupName, [profile]);
				}
			} else {
				ungrouped.push(profile);
			}
		}

		const result: { name: string | null; profiles: QualityProfileSummary[] }[] = [];
		for (const [name, profiles] of orderMap) {
			result.push({ name, profiles });
		}
		if (ungrouped.length > 0) {
			result.push({ name: "Other", profiles: ungrouped });
		}

		return result;
	}, [data?.profiles, searchQuery]);

	// Show search box when profiles are grouped (has sections) OR many profiles
	const showSearch = useMemo(() => {
		if (!data?.profiles) return false;
		const hasGroups = data.profiles.some((p) => p.groupName);
		return hasGroups || data.profiles.length > 8;
	}, [data?.profiles]);

	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-modal flex items-center justify-center bg-black/50 backdrop-blur-xs"
			role="dialog"
			aria-modal="true"
			aria-labelledby="quality-profile-browser-title"
		>
			<div className="relative w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-xl border border-border bg-card shadow-xl">
				{/* Header */}
				<div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card/95 p-6 backdrop-blur-sm">
					<div>
						<h2
							id="quality-profile-browser-title"
							className="text-xl font-semibold text-foreground"
						>
							Browse TRaSH Quality Profiles
						</h2>
						<p className="mt-1 text-sm text-muted-foreground">
							Select a quality profile to import as a template for {serviceType}
						</p>
					</div>
					<Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog">
						<X className="h-5 w-5" />
					</Button>
				</div>

				{/* Content */}
				<div className="overflow-y-auto p-6" style={{ maxHeight: "calc(90vh - 180px)" }}>
					{importMutation.isError && (
						<Alert variant="danger" className="mb-4">
							<AlertDescription>
								{getErrorMessage(importMutation.error, "Failed to import quality profile")}
							</AlertDescription>
						</Alert>
					)}

					{error && (
						<Alert variant="danger">
							<AlertDescription>
								{getErrorMessage(error, "Failed to load quality profiles")}
							</AlertDescription>
						</Alert>
					)}

					{isLoading ? (
						<div className="grid gap-4 md:grid-cols-2">
							{Array.from({ length: 4 }).map((_, i) => (
								<PremiumSkeleton
									key={i}
									variant="card"
									className="h-48"
									style={{ animationDelay: `${i * 50}ms` }}
								/>
							))}
						</div>
					) : data?.profiles.length === 0 ? (
						<EmptyState
							icon={FileText}
							title="No quality profiles available"
							description="No TRaSH Guides quality profiles found for this service"
						/>
					) : (
						<>
							{!selectedProfile ? (
								<div className="space-y-4">
									{/* Search */}
									{showSearch && (
										<div className="relative">
											<Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
											<input
												type="text"
												placeholder="Search profiles..."
												value={searchQuery}
												onChange={(e) => setSearchQuery(e.target.value)}
												className="w-full rounded-lg border border-border/50 bg-card/30 backdrop-blur-sm pl-9 pr-4 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 transition-all"
											/>
										</div>
									)}

									{/* Profile groups or empty search state */}
									{searchQuery.trim().length > 0 &&
									groupedProfiles.length === 1 &&
									groupedProfiles[0]?.profiles.length === 0 ? (
										<EmptyState
											icon={Search}
											title="No profiles match your search"
											description={`No profiles found for "${searchQuery}"`}
										/>
									) : (
										<div className="space-y-4">
											{groupedProfiles.map((group, groupIndex) => (
												<BrowserGroupSection
													key={group.name ?? "__flat__"}
													groupName={group.name}
													profiles={group.profiles}
													onSelect={handleSelectProfile}
													defaultExpanded={groupIndex < 3}
												/>
											))}
										</div>
									)}
								</div>
							) : (
								<div className="space-y-4">
									<div className="rounded-xl border border-border bg-card/50 p-6">
										<div className="mb-4 flex items-center justify-between">
											<div>
												<h3 className="text-lg font-medium text-foreground">
													{selectedProfile.name}
												</h3>
												<p className="mt-1 text-sm text-muted-foreground">
													{selectedProfile.customFormatCount} Custom Formats •{" "}
													{selectedProfile.qualityCount} Quality Settings
												</p>
											</div>
											<Button
												variant="secondary"
												size="sm"
												onClick={() => setSelectedProfile(null)}
											>
												Change Selection
											</Button>
										</div>

										{selectedProfile.description && (
											<SanitizedHtml
												html={selectedProfile.description}
												className="text-sm text-muted-foreground"
											/>
										)}
									</div>

									<div className="space-y-4">
										<div>
											<label className="mb-2 block text-sm font-medium text-foreground">
												Template Name <span className="text-danger">*</span>
											</label>
											<Input
												type="text"
												value={templateName}
												onChange={(e) => setTemplateName(e.target.value)}
												placeholder="Enter template name"
												className="w-full"
											/>
										</div>

										<div>
											<label className="mb-2 block text-sm font-medium text-foreground">
												Description (Optional)
											</label>
											<textarea
												value={templateDescription}
												onChange={(e) => setTemplateDescription(e.target.value)}
												placeholder="Enter template description"
												rows={4}
												className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 transition-all duration-200 hover:border-border/80 hover:bg-card/80 focus:border-primary focus:outline-hidden focus:ring-2 focus:ring-primary/20 focus:bg-card/80"
											/>
										</div>
									</div>
								</div>
							)}
						</>
					)}
				</div>

				{/* Footer */}
				<div className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-card/95 p-6 backdrop-blur-sm">
					<Button variant="secondary" onClick={onClose}>
						Cancel
					</Button>
					{selectedProfile && (
						<Button
							variant="primary"
							onClick={handleImport}
							disabled={!templateName.trim() || importMutation.isPending}
							className="gap-2"
						>
							{importMutation.isPending ? (
								<>
									<div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-fg/30 border-t-primary-fg" />
									Importing...
								</>
							) : (
								<>
									<Download className="h-4 w-4" />
									Import as Template
								</>
							)}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
};
