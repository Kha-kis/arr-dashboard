/**
 * Quality Configuration Step
 * Allows users to configure quality settings before CF configuration
 */

"use client";

import { useState, useEffect, useRef } from "react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../../../../components/ui";
import { PremiumSkeleton } from "../../../../components/layout/premium-components";
import { ChevronLeft, ChevronRight, Gauge, AlertCircle } from "lucide-react";
import type { CustomQualityConfig } from "@arr/shared";
import type { QualityProfileSummary } from "../../../../lib/api-client/trash-guides";
import { QualityGroupEditor } from "../quality-group-editor";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "../../../../lib/api-client/base";

/**
 * Wizard-specific profile type that allows undefined trashId for edit mode.
 */
type WizardSelectedProfile = Omit<QualityProfileSummary, 'trashId'> & {
	trashId?: string;
};

interface QualityConfigurationProps {
	serviceType: "RADARR" | "SONARR";
	qualityProfile: WizardSelectedProfile;
	initialQualityConfig?: CustomQualityConfig;
	onNext: (qualityConfig: CustomQualityConfig) => void;
	onBack?: () => void;
	isEditMode?: boolean;
}

/**
 * Check if a trashId indicates a cloned profile from an instance
 */
function isClonedProfile(trashId: string | undefined): boolean {
	return !!trashId && trashId.startsWith("cloned-");
}

/**
 * Parse cloned profile trashId to extract instanceId and profileId
 */
function parseClonedProfileId(trashId: string): { instanceId: string; profileId: number } | null {
	if (!isClonedProfile(trashId)) return null;

	const withoutPrefix = trashId.slice(7);
	if (!withoutPrefix) return null;

	const parts = withoutPrefix.split("-");
	if (parts.length < 4) return null;

	const uuidParts5 = parts.slice(-5);
	const uuidCandidate5 = uuidParts5.join("-");
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

	let profileIdIndex: number;

	if (uuidRegex.test(uuidCandidate5) && parts.length >= 7) {
		profileIdIndex = parts.length - 6;
	} else {
		const uuidParts2 = parts.slice(-2);
		if (parts.length < 4) return null;

		const timestampPart = uuidParts2[0];
		const randomPart = uuidParts2[1];

		if (timestampPart && randomPart && /^\d+$/.test(timestampPart) && /^[a-z0-9]+$/i.test(randomPart)) {
			profileIdIndex = parts.length - 3;
		} else {
			return null;
		}
	}

	const profileIdStr = parts[profileIdIndex];
	const instanceIdParts = parts.slice(0, profileIdIndex);
	const instanceId = instanceIdParts.join("-");

	if (!instanceId || !profileIdStr) return null;

	const profileId = parseInt(profileIdStr, 10);
	if (isNaN(profileId) || profileId < 0) return null;

	return { instanceId, profileId };
}

/**
 * Extract quality items from TRaSH profile
 */
function extractQualityItems(profile: any): Array<{
	name: string;
	allowed: boolean;
	source?: string;
	resolution?: number;
	items?: string[];
}> {
	if (!profile?.items || !Array.isArray(profile.items)) {
		return [];
	}

	return profile.items.map((item: any) => ({
		name: item.name,
		allowed: item.allowed ?? true,
		source: item.quality?.source,
		resolution: item.quality?.resolution,
		items: item.items,
	}));
}

export const QualityConfiguration = ({
	serviceType,
	qualityProfile,
	initialQualityConfig,
	onNext,
	onBack,
	isEditMode = false,
}: QualityConfigurationProps) => {
	const hasInitializedQualityConfig = useRef(!!initialQualityConfig);
	const [customQualityConfig, setCustomQualityConfig] = useState<CustomQualityConfig>(
		initialQualityConfig ?? { useCustomQualities: false, items: [] }
	);

	const isCloned = isClonedProfile(qualityProfile.trashId);
	const clonedInfo = qualityProfile.trashId ? parseClonedProfileId(qualityProfile.trashId) : null;

	// Fetch quality data from the profile
	const { data, isLoading, error } = useQuery({
		queryKey: isCloned
			? ["cloned-profile-quality", qualityProfile.trashId]
			: ["quality-profile-quality", serviceType, qualityProfile.trashId],
		queryFn: async () => {
			if (isCloned && clonedInfo) {
				// Fetch from cloned profile
				const response = await apiRequest<any>(
					`/api/trash-guides/profile-clone/profile-details/${clonedInfo.instanceId}/${clonedInfo.profileId}`
				);
				if (!response.success || !response.data) {
					throw new Error(response.error || "Failed to fetch profile details");
				}
				const { profile } = response.data;
				return {
					qualityItems: profile.items?.map((item: any) => ({
						name: item.name || item.quality?.name,
						allowed: item.allowed ?? true,
						source: item.quality?.source,
						resolution: item.quality?.resolution,
						items: item.items?.map((q: any) => typeof q === 'string' ? q : q.name || q.quality?.name),
					})) || [],
					profile: {
						cutoff: profile.cutoff,
					},
				};
			} else if (qualityProfile.trashId) {
				// Fetch from TRaSH profile
				const profileData = await apiRequest<any>(
					`/api/trash-guides/quality-profiles/${serviceType}/${qualityProfile.trashId}`
				);
				if (profileData.statusCode || profileData.error) {
					throw new Error(profileData.message || "Failed to fetch quality profile");
				}
				return {
					qualityItems: extractQualityItems(profileData.profile),
					profile: profileData.profile,
				};
			}
			return { qualityItems: [], profile: null };
		},
		enabled: !initialQualityConfig && !!qualityProfile.trashId,
	});

	// Initialize quality configuration from fetched data
	useEffect(() => {
		if (hasInitializedQualityConfig.current) {
			return;
		}

		if (!data?.qualityItems || data.qualityItems.length === 0) {
			return;
		}

		// Convert qualityItems to CustomQualityConfig format
		const items = data.qualityItems.map((item: any, index: number) => {
			const id = `q-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;

			// Check if this is a quality group (has nested items)
			if (item.items && Array.isArray(item.items) && item.items.length > 0) {
				return {
					type: "group" as const,
					group: {
						id,
						name: item.name,
						allowed: item.allowed ?? true,
						qualities: item.items.map((qualityName: string, qIndex: number) => ({
							id: `q-${Date.now()}-${index}-${qIndex}-${Math.random().toString(36).slice(2, 7)}`,
							name: qualityName,
							allowed: true,
						})),
					},
				};
			}

			// Single quality item
			return {
				type: "quality" as const,
				item: {
					id,
					name: item.name,
					allowed: item.allowed ?? true,
				},
			};
		});

		// Find cutoffId
		let cutoffId: string | undefined;
		const profileCutoffName = data.profile?.cutoff;
		if (profileCutoffName) {
			for (const entry of items) {
				if (entry.type === "quality" && entry.item.name === profileCutoffName) {
					cutoffId = entry.item.id;
					break;
				} else if (entry.type === "group" && entry.group.name === profileCutoffName) {
					cutoffId = entry.group.id;
					break;
				}
			}
		}

		hasInitializedQualityConfig.current = true;
		setCustomQualityConfig({
			useCustomQualities: false,
			items,
			cutoffId,
		});
	}, [data]);

	const handleNext = () => {
		onNext(customQualityConfig);
	};

	if (isLoading) {
		return (
			<div className="space-y-6">
				<Card>
					<CardHeader>
						<PremiumSkeleton variant="line" className="h-6 w-48" />
						<PremiumSkeleton variant="line" className="h-4 w-96 mt-2" style={{ animationDelay: "50ms" }} />
					</CardHeader>
					<CardContent>
						<div className="space-y-4">
							{Array.from({ length: 3 }).map((_, i) => (
								<PremiumSkeleton
									key={i}
									variant="card"
									className="h-12 w-full"
									style={{ animationDelay: `${(i + 2) * 50}ms` }}
								/>
							))}
						</div>
					</CardContent>
				</Card>
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-6">
				<Card className="border-red-500/30 bg-red-500/5">
					<CardContent className="pt-6">
						<div className="flex items-center gap-3 text-red-400">
							<AlertCircle className="h-5 w-5" />
							<p>Failed to load quality configuration: {error instanceof Error ? error.message : "Unknown error"}</p>
						</div>
					</CardContent>
				</Card>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Quality Configuration Card */}
			<Card className="border-amber-500/30 bg-amber-500/5">
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Gauge className="h-5 w-5 text-amber-400" />
						Quality Configuration
						<span className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400">
							Advanced
						</span>
					</CardTitle>
					<CardDescription>
						Configure which qualities are enabled, create quality groups, and set the cutoff for upgrades.
						These settings will be applied when deploying to your instances.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<QualityGroupEditor
						config={customQualityConfig}
						onChange={setCustomQualityConfig}
						showToggle={true}
						serviceType={serviceType}
					/>
				</CardContent>
			</Card>

			{/* Navigation */}
			<div className="flex items-center justify-between border-t border-border/50 pt-6">
				{onBack && (
					<button
						type="button"
						onClick={onBack}
						className="inline-flex items-center gap-2 rounded-lg bg-muted px-4 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
					>
						<ChevronLeft className="h-4 w-4" />
						Back
					</button>
				)}
				<div className="flex-1" />
				<button
					type="button"
					onClick={handleNext}
					className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition hover:bg-primary/90"
				>
					Continue to Custom Formats
					<ChevronRight className="h-4 w-4" />
				</button>
			</div>
		</div>
	);
};
