"use client";

import type { CompleteQualityProfile } from "@arr/shared";
import {
	ChevronDown,
	Download,
	FileText,
	Gauge,
	Info,
	Languages,
	Layers,
	Search,
	Star,
} from "lucide-react";
import { useMemo, useState } from "react";
import { PremiumSkeleton } from "../../../../components/layout/premium-components";
import {
	Alert,
	AlertDescription,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	EmptyState,
} from "../../../../components/ui";
import { useQualityProfiles } from "../../../../hooks/api/useQualityProfiles";
import { useThemeGradient } from "../../../../hooks/useThemeGradient";
import type { QualityProfileSummary } from "../../../../lib/api-client/trash-guides";
import { getErrorMessage } from "../../../../lib/error-utils";
import { createSanitizedHtml } from "../../../../lib/sanitize-html";
import { QualityProfileImporter } from "../quality-profile-importer";

interface QualityProfileSelectionProps {
	serviceType: "RADARR" | "SONARR";
	onSelect: (profile: QualityProfileSummary) => void;
}

// ============================================================================
// ProfileCard sub-component
// ============================================================================

interface ProfileCardProps {
	profile: QualityProfileSummary;
	onSelect: (profile: QualityProfileSummary) => void;
}

const ProfileCard = ({ profile, onSelect }: ProfileCardProps) => (
	<Card
		className="cursor-pointer transition-all hover:border-primary hover:shadow-lg hover:shadow-primary/10"
		onClick={() => onSelect(profile)}
	>
		<CardHeader>
			<div className="flex items-start justify-between gap-2">
				<CardTitle>{profile.name}</CardTitle>
				{profile.scoreSet && (
					<span className="rounded bg-primary/20 px-2 py-1 text-xs text-primary whitespace-nowrap">
						{profile.scoreSet}
					</span>
				)}
			</div>

			{profile.description && (
				<CardDescription
					className="line-clamp-2"
					dangerouslySetInnerHTML={createSanitizedHtml(profile.description)}
				/>
			)}
		</CardHeader>

		<CardContent>
			<div className="space-y-3">
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

				<div className="flex items-center justify-between text-xs">
					<span className="text-muted-foreground">Cutoff: {profile.cutoff}</span>
					<span
						className={`rounded px-2 py-1 ${
							profile.upgradeAllowed
								? "bg-green-500/20 text-green-300"
								: "bg-muted text-muted-foreground"
						}`}
					>
						{profile.upgradeAllowed ? "Upgrades On" : "Upgrades Off"}
					</span>
				</div>
			</div>
		</CardContent>
	</Card>
);

// ============================================================================
// ProfileGroupSection sub-component
// ============================================================================

interface ProfileGroupSectionProps {
	groupName: string | null;
	profiles: QualityProfileSummary[];
	onSelect: (profile: QualityProfileSummary) => void;
	defaultExpanded?: boolean;
}

const ProfileGroupSection = ({
	groupName,
	profiles,
	onSelect,
	defaultExpanded = true,
}: ProfileGroupSectionProps) => {
	const [expanded, setExpanded] = useState(defaultExpanded);
	const { gradient } = useThemeGradient();

	// No header when groupName is null (flat/search mode)
	if (groupName === null) {
		return (
			<div className="grid gap-4 md:grid-cols-2">
				{profiles.map((profile, index) => (
					<div
						key={profile.trashId}
						className="animate-in fade-in slide-in-from-bottom-2 duration-slow"
						style={{ animationDelay: `${index * 30}ms`, animationFillMode: "backwards" }}
					>
						<ProfileCard profile={profile} onSelect={onSelect} />
					</div>
				))}
			</div>
		);
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
			{expanded && (
				<div className="px-4 pb-4 grid gap-4 md:grid-cols-2">
					{profiles.map((profile, index) => (
						<div
							key={profile.trashId}
							className="animate-in fade-in slide-in-from-bottom-2 duration-slow"
							style={{ animationDelay: `${index * 30}ms`, animationFillMode: "backwards" }}
						>
							<ProfileCard profile={profile} onSelect={onSelect} />
						</div>
					))}
				</div>
			)}
		</div>
	);
};

// ============================================================================
// Main component
// ============================================================================

export const QualityProfileSelection = ({
	serviceType,
	onSelect,
}: QualityProfileSelectionProps) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [showCloneImporter, setShowCloneImporter] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const { data, isLoading, error } = useQualityProfiles(serviceType);

	// Handle imported profile from cloning
	const handleProfileImported = (importedProfile: CompleteQualityProfile) => {
		// Generate unique ID using crypto if available, falling back to timestamp
		const uniqueSuffix =
			typeof crypto !== "undefined" && crypto.randomUUID
				? crypto.randomUUID()
				: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

		// Count custom formats from profile items (items with negative IDs indicate custom formats)
		const customFormatCount = importedProfile.items.filter(
			(item) => item.id !== undefined && item.id < 0,
		).length;

		// Use friendly instance label if available, fall back to instance ID
		const instanceDisplayName =
			importedProfile.sourceInstanceLabel || importedProfile.sourceInstanceId;

		// Convert CompleteQualityProfile to QualityProfileSummary format for wizard
		const profileSummary: QualityProfileSummary = {
			trashId: `cloned-${importedProfile.sourceInstanceId}-${importedProfile.sourceProfileId}-${uniqueSuffix}`,
			name: importedProfile.sourceProfileName,
			description: `Cloned from ${instanceDisplayName}`,
			scoreSet: undefined,
			customFormatCount,
			qualityCount: importedProfile.items.length,
			language: importedProfile.language?.name,
			cutoff: importedProfile.cutoffQuality?.name || "Unknown",
			upgradeAllowed: importedProfile.upgradeAllowed,
		};

		onSelect(profileSummary);
		setShowCloneImporter(false);
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

	if (isLoading) {
		return (
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
		);
	}

	if (error) {
		return (
			<Alert variant="danger">
				<AlertDescription>
					{getErrorMessage(error, "Failed to load quality profiles")}
				</AlertDescription>
			</Alert>
		);
	}

	if (!data?.profiles.length) {
		return (
			<EmptyState
				icon={FileText}
				title="No quality profiles available"
				description="No TRaSH Guides quality profiles found for this service"
			/>
		);
	}

	// Show clone importer if user selected that option
	if (showCloneImporter) {
		return (
			<div className="space-y-4">
				<div className="flex items-center justify-between">
					<div>
						<h3 className="text-lg font-semibold text-foreground">Clone from Instance</h3>
						<p className="text-sm text-muted-foreground mt-1">
							Import a complete quality profile from an existing *arr instance
						</p>
					</div>
					<Button variant="secondary" onClick={() => setShowCloneImporter(false)}>
						Back to TRaSH Guides
					</Button>
				</div>

				<QualityProfileImporter
					serviceType={serviceType}
					onImportComplete={handleProfileImported}
					onClose={() => setShowCloneImporter(false)}
				/>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Introduction */}
			<Alert>
				<Info className="h-4 w-4" />
				<AlertDescription>
					<strong>Quality profiles</strong> are expert-curated configurations from TRaSH Guides that
					define quality preferences, custom format rules, and scoring systems. Choose a profile
					that matches your quality preferences.
				</AlertDescription>
			</Alert>

			{/* Source Selection */}
			<div className="flex gap-3">
				<Card className="flex-1 border-primary shadow-md bg-primary/5">
					<CardContent className="pt-6">
						<div className="flex items-center gap-3">
							<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/20">
								<Layers className="h-5 w-5 text-primary" />
							</div>
							<div className="flex-1">
								<div className="font-medium text-foreground">TRaSH Guides Profiles</div>
								<div className="text-xs text-muted-foreground mt-0.5">
									Expert-curated configurations (selected)
								</div>
							</div>
						</div>
					</CardContent>
				</Card>

				<Card
					className="flex-1 cursor-pointer transition-all hover:border-primary hover:shadow-md"
					onClick={() => setShowCloneImporter(true)}
				>
					<CardContent className="pt-6">
						<div className="flex items-center gap-3">
							<div
								className="flex h-10 w-10 items-center justify-center rounded-lg"
								style={{ backgroundColor: themeGradient.fromLight }}
							>
								<Download className="h-5 w-5" style={{ color: themeGradient.from }} />
							</div>
							<div className="flex-1">
								<div className="font-medium text-foreground">Clone from Instance</div>
								<div className="text-xs text-muted-foreground mt-0.5">
									Import from existing *arr instance
								</div>
							</div>
						</div>
					</CardContent>
				</Card>
			</div>

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
						<ProfileGroupSection
							key={group.name ?? "__flat__"}
							groupName={group.name}
							profiles={group.profiles}
							onSelect={onSelect}
							defaultExpanded={groupIndex < 3}
						/>
					))}
				</div>
			)}
		</div>
	);
};
