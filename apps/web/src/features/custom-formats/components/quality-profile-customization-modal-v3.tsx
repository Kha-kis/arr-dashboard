"use client";

import React, { useState, useEffect } from "react";
import DOMPurify from "dompurify";
import { Dialog, DialogHeader, DialogTitle, DialogContent, DialogFooter, Button, Badge, Input, Card, Skeleton, toast } from "../../../components/ui";
import type { TrashQualityProfile } from "../../../lib/api-client/trash-guides";
import { useTrashFormats, useRecommendedCFs } from "../../../hooks/api/useTrashGuides";
import type { TrashCustomFormat } from "../../../lib/api-client/trash-guides";
import { getCFDescription } from "../utils/cf-descriptions";
import { previewQualityProfile } from "../../../lib/api-client/trash-guides";
import { QualityProfileDiffPreview } from "./quality-profile-diff-preview";
import type { DiffPlan } from "@arr/shared";

interface QualityProfileCustomizationModalProps {
	isOpen: boolean;
	onClose: () => void;
	profile: TrashQualityProfile;
	service: "SONARR" | "RADARR";
	instanceId: string;
	onApply: (customizations: Record<string, CustomizationSettings>) => Promise<void>;
	isApplying: boolean;
}

interface CustomizationSettings {
	excluded?: boolean;
	scoreOverride?: number;
}

interface EnrichedFormatItem {
	name: string;
	trashId: string;
	defaultScore: number;
	description?: string;
	cfGroup?: string; // CF group name (from TRaSH CF groups)
	cfGroupDescription?: string; // CF group description from TRaSH
	isActive: boolean; // CF is active in the profile (either in profile or recommended)
	category?: string; // CF category (Audio, HDR, Movie Versions, etc.)
	isOptional?: boolean; // TRaSH marks this as optional (from "optional-*" CF groups)
	isNicheStreaming?: boolean; // Non-general streaming services (hidden by default)
	isRecommended?: boolean; // TRaSH recommends this CF for the profile (shows as recommended badge)
	required?: boolean; // CF is required when using this group
	default?: boolean; // CF should be pre-selected by default
	isMutuallyExclusive?: boolean; // Only one CF from this group should be selected
	semanticCategory?: string; // Semantic category for grouping (HDR Formats, Audio, etc.)
}

// Helper to sanitize HTML descriptions
function sanitizeHtml(html: string) {
	return DOMPurify.sanitize(html, {
		ALLOWED_TAGS: ['br', 'b', 'i', 'em', 'strong', 'a', 'p', 'ul', 'ol', 'li'],
		ALLOWED_ATTR: ['href', 'target', 'rel'],
	});
}

// Helper to categorize CFs based on name patterns
function categorizeCF(name: string): string {
	const nameLower = name.toLowerCase();

	// Audio formats
	if (nameLower.includes('truehd') || nameLower.includes('dts') ||
	    nameLower.includes('atmos') || nameLower.includes('flac') ||
	    nameLower.includes('pcm') || nameLower.includes('aac') ||
	    nameLower.includes('dd+') || nameLower.includes('dd ') ||
	    name.match(/^(AAC|DD|DTS|PCM|FLAC|TrueHD)/i)) {
		return 'Audio Formats';
	}

	// HDR formats
	if (nameLower.includes('hdr') || nameLower.includes('dolby vision') ||
	    nameLower.includes('dv ') || name.startsWith('DV') ||
	    nameLower.includes('sdr')) {
		return 'HDR Formats';
	}

	// Movie versions
	if (nameLower.includes('remaster') || nameLower.includes('criterion') ||
	    nameLower.includes('imax') || nameLower.includes('special edition') ||
	    nameLower.includes('masters of cinema') || nameLower.includes('vinegar syndrome')) {
		return 'Movie Versions';
	}

	// Unwanted/Optional
	if (nameLower.includes('x265') || nameLower.includes('x264') ||
	    nameLower.includes('bad dual') || nameLower.includes('no-rlsgroup') ||
	    nameLower.includes('obfuscated') || nameLower.includes('retag') ||
	    nameLower.includes('scene')) {
		return 'Optional / Unwanted';
	}

	// Resolution/Quality
	if (nameLower.includes('2160p') || nameLower.includes('1080p') ||
	    nameLower.includes('720p') || nameLower.includes('remux') ||
	    nameLower.includes('bluray') || nameLower.includes('web-dl') ||
	    nameLower.includes('webdl') || nameLower.includes('webrip')) {
		return 'Resolution / Source';
	}

	// Release groups
	if (nameLower.includes('tier') || nameLower.includes('group') ||
	    nameLower.includes('p2p') || nameLower.includes('scene')) {
		return 'Release Groups';
	}

	return 'Other';
}


export function QualityProfileCustomizationModalV3({
	isOpen,
	onClose,
	profile,
	service,
	instanceId,
	onApply,
	isApplying,
}: QualityProfileCustomizationModalProps) {
	const [customizations, setCustomizations] = useState<Record<string, CustomizationSettings>>({});
	const [showChangesPreview, setShowChangesPreview] = React.useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [expandedDescriptions, setExpandedDescriptions] = useState<Set<string>>(new Set());
	const [showInactiveCFs, setShowInactiveCFs] = useState(false); // Toggle to show inactive CFs
	const [showHelpText, setShowHelpText] = useState(false); // Toggle to show help text
	const [statusFilter, setStatusFilter] = useState<'all' | 'recommended' | 'active' | 'excluded' | 'overridden'>('all');
	const [categoryFilter, setCategoryFilter] = useState<string>('all');

	// Preview state
	const [previewMode, setPreviewMode] = useState(false);
	const [diffPlan, setDiffPlan] = useState<DiffPlan | null>(null);
	const [isLoadingPreview, setIsLoadingPreview] = useState(false);

	// Fetch TRaSH custom formats to enrich the data
	const { data: trashFormatsData, isLoading: isLoadingFormats } = useTrashFormats(service);

	// Fetch recommended CFs for this profile
	const { data: recommendedCFsData, isLoading: isLoadingRecommended } = useRecommendedCFs(
		service,
		profile.trash_id
	);

	// Parse ALL available TRaSH CFs and mark which ones are in the profile
	const formatItems: EnrichedFormatItem[] = React.useMemo(() => {
		if (!trashFormatsData?.customFormats) return [];

		const scoreSet = profile.trash_score_set || "default";
		const formats: EnrichedFormatItem[] = [];
		const profileFormatIds = new Set(Object.values(profile.formatItems || {}));

		// Create a map of recommended CFs from the API response
		const recommendedCFsMap = new Map(
			(recommendedCFsData?.recommendedCFs || []).map(cf => [
				cf.trashId,
				{
					cfGroupName: cf.cfGroupName,
					cfGroupDescription: cf.cfGroupDescription,
					isOptional: cf.isOptional,
					isNicheStreaming: cf.isNicheStreaming,
					isMutuallyExclusive: cf.isMutuallyExclusive,
					required: cf.required,
					default: cf.default,
					semanticCategory: cf.semanticCategory
				}
			])
		);

		// Iterate through ALL TRaSH custom formats
		for (const trashFormat of trashFormatsData.customFormats) {
			const isInProfile = profileFormatIds.has(trashFormat.trash_id);

			// Get score from trash_scores using the score set (or default)
			const score = trashFormat.trash_scores?.[scoreSet] ?? trashFormat.trash_scores?.["default"] ?? 0;

			// Check if this CF is recommended from TRaSH CF groups
			const recommendedInfo = recommendedCFsMap.get(trashFormat.trash_id);
			const isRecommended = !!recommendedInfo && !isInProfile;
			const isOptional = recommendedInfo?.isOptional || false;
			const isNicheStreaming = recommendedInfo?.isNicheStreaming || false;
			const isMutuallyExclusive = recommendedInfo?.isMutuallyExclusive || false;

			// Simplified: CF is active if in profile OR recommended
			const isActive = isInProfile || isRecommended;

			formats.push({
				name: trashFormat.name,
				trashId: trashFormat.trash_id,
				defaultScore: score,
				description: trashFormat.trash_description,
				isActive,
				category: categorizeCF(trashFormat.name),
				cfGroup: recommendedInfo?.cfGroupName,
				cfGroupDescription: recommendedInfo?.cfGroupDescription,
				isRecommended,
				isOptional,
				isNicheStreaming,
				required: recommendedInfo?.required,
				default: recommendedInfo?.default,
				isMutuallyExclusive,
				semanticCategory: recommendedInfo?.semanticCategory,
			});
		}

		// Sort: active CFs first, then by semantic category, then by CF group, then by name
		return formats.sort((a, b) => {
			// Prioritize active CFs
			if (a.isActive && !b.isActive) return -1;
			if (!a.isActive && b.isActive) return 1;

			// Group by semantic category (CFs with semantic categories first, then alphabetically)
			const aHasCategory = !!a.semanticCategory;
			const bHasCategory = !!b.semanticCategory;
			if (aHasCategory && !bHasCategory) return -1;
			if (!aHasCategory && bHasCategory) return 1;
			if (aHasCategory && bHasCategory) {
				const categoryCompare = a.semanticCategory!.localeCompare(b.semanticCategory!);
				if (categoryCompare !== 0) return categoryCompare;
			}

			// Within each semantic category, group by CF group (then alphabetically by group name)
			const aHasGroup = !!a.cfGroup;
			const bHasGroup = !!b.cfGroup;
			if (aHasGroup && !bHasGroup) return -1;
			if (!aHasGroup && bHasGroup) return 1;
			if (aHasGroup && bHasGroup) {
				const groupCompare = a.cfGroup!.localeCompare(b.cfGroup!);
				if (groupCompare !== 0) return groupCompare;
			}

			// Within each group (or for CFs without groups), sort by name
			return a.name.localeCompare(b.name);
		});
	}, [profile, trashFormatsData, recommendedCFsData]);

	// Reset when profile changes and auto-exclude optional CFs
	// For mutually exclusive groups, include the first option by default and exclude the rest
	useEffect(() => {
		const autoExclusions: Record<string, CustomizationSettings> = {};

		// Track which mutually exclusive groups we've seen (to auto-select first option)
		const mutuallyExclusiveGroups = new Map<string, string[]>(); // groupName -> [trashIds]

		// Auto-exclude optional CFs and handle mutually exclusive groups
		if (recommendedCFsData?.recommendedCFs) {
			const profileFormatIds = new Set(Object.values(profile.formatItems || {}));

			// First pass: group mutually exclusive CFs
			for (const recommendedCF of recommendedCFsData.recommendedCFs) {
				if (recommendedCF.isMutuallyExclusive && recommendedCF.cfGroupName) {
					if (!mutuallyExclusiveGroups.has(recommendedCF.cfGroupName)) {
						mutuallyExclusiveGroups.set(recommendedCF.cfGroupName, []);
					}
					mutuallyExclusiveGroups.get(recommendedCF.cfGroupName)!.push(recommendedCF.trashId);
				}
			}

			// Second pass: apply exclusions and defaults
			for (const recommendedCF of recommendedCFsData.recommendedCFs) {
				// Skip if already in profile
				if (profileFormatIds.has(recommendedCF.trashId)) continue;

				// Handle mutually exclusive groups
				if (recommendedCF.isMutuallyExclusive && recommendedCF.cfGroupName) {
					const groupCFs = mutuallyExclusiveGroups.get(recommendedCF.cfGroupName) || [];

					// Find the default CF in this group, or use first if no default
					let defaultCFId = groupCFs[0];
					for (const cfId of groupCFs) {
						const cfData = recommendedCFsData.recommendedCFs.find(cf => cf.trashId === cfId);
						if (cfData?.default) {
							defaultCFId = cfId;
							break;
						}
					}

					// Exclude all CFs except the default one
					if (recommendedCF.trashId !== defaultCFId) {
						autoExclusions[recommendedCF.trashId] = {
							excluded: true,
						};
					}
					// Default option is NOT excluded (included by default)
					continue;
				}

				// Handle optional CFs (exclude by default unless they have default: true)
				if (recommendedCF.isOptional) {
					if (!recommendedCF.default) {
						// Exclude optional CFs that aren't marked as default
						autoExclusions[recommendedCF.trashId] = {
							excluded: true,
						};
					}
					// If default: true, don't exclude (include by default)
				}
			}
		}

		setCustomizations(autoExclusions);
		setSearchQuery("");
		setExpandedDescriptions(new Set());
		setShowInactiveCFs(false);
	}, [profile, recommendedCFsData]);

	// Filter formats based on search query, status, category, and showInactiveCFs toggle
	const filteredFormats = React.useMemo(() => {
		return formatItems.filter(format => {
			// Apply search filter
			const matchesSearch = !searchQuery || format.name.toLowerCase().includes(searchQuery.toLowerCase());

			// CF groups to hide by default (only shown when "Show Other CFs" is toggled)
			const hiddenCFGroups = [
				"[Optional] Movie Versions",
				"[Audio] Audio Formats",
				"[Optional] Miscellaneous"
			];
			const isHiddenCFGroup = format.cfGroup && hiddenCFGroups.includes(format.cfGroup);

			// Apply visibility filter
			// Hide CFs from hidden CF groups and niche streaming, even if active
			// Show all CFs only when "Show Inactive CFs" is toggled
			const matchesVisibility =
				showInactiveCFs ||
				(!isHiddenCFGroup && !format.isNicheStreaming && (
					format.isActive || format.isRecommended
				));

			// Apply status filter
			const customization = customizations[format.trashId];
			const isExcluded = customization?.excluded || false;
			const hasOverride = customization?.scoreOverride !== undefined;

			const matchesStatus =
				statusFilter === 'all' ||
				(statusFilter === 'recommended' && format.isRecommended) ||
				(statusFilter === 'active' && format.isActive && !isExcluded) ||
				(statusFilter === 'excluded' && isExcluded) ||
				(statusFilter === 'overridden' && hasOverride);

			// Apply category filter
			const matchesCategory =
				categoryFilter === 'all' ||
				(format.semanticCategory || 'Other') === categoryFilter;

			return matchesSearch && matchesVisibility && matchesStatus && matchesCategory;
		});
	}, [formatItems, searchQuery, showInactiveCFs, statusFilter, categoryFilter, customizations]);

	// Get unique categories for filter dropdown
	const availableCategories = React.useMemo(() => {
		const categories = new Set(formatItems.map(f => f.semanticCategory || 'Other'));
		return Array.from(categories).sort();
	}, [formatItems]);

	// Group by semantic category first, then separate mutually exclusive groups
	const semanticCategoryMap = React.useMemo(() => {
		const map = new Map<string, {
			mutuallyExclusiveGroups: Map<string, EnrichedFormatItem[]>;
			regularFormats: EnrichedFormatItem[];
		}>();

		for (const format of filteredFormats) {
			const category = format.semanticCategory || 'Other';

			if (!map.has(category)) {
				map.set(category, {
					mutuallyExclusiveGroups: new Map(),
					regularFormats: []
				});
			}

			const categoryData = map.get(category)!;

			if (format.isMutuallyExclusive && format.cfGroup) {
				if (!categoryData.mutuallyExclusiveGroups.has(format.cfGroup)) {
					categoryData.mutuallyExclusiveGroups.set(format.cfGroup, []);
				}
				categoryData.mutuallyExclusiveGroups.get(format.cfGroup)!.push(format);
			} else {
				categoryData.regularFormats.push(format);
			}
		}

		return map;
	}, [filteredFormats]);

	// Toggle exclusion
	const toggleExclude = (trashId: string) => {
		setCustomizations(prev => ({
			...prev,
			[trashId]: {
				...prev[trashId],
				excluded: !prev[trashId]?.excluded,
			},
		}));
	};

	// Toggle exclusion for mutually exclusive groups (radio-button behavior)
	const toggleMutuallyExclusiveOption = (selectedTrashId: string, groupName: string) => {
		// Find the group formats from any semantic category
		let groupFormats: EnrichedFormatItem[] = [];
		for (const [_, categoryData] of semanticCategoryMap) {
			if (categoryData.mutuallyExclusiveGroups.has(groupName)) {
				groupFormats = categoryData.mutuallyExclusiveGroups.get(groupName)!;
				break;
			}
		}

		setCustomizations(prev => {
			const newCustomizations = { ...prev };

			// Exclude all options in the group
			for (const format of groupFormats) {
				newCustomizations[format.trashId] = {
					...newCustomizations[format.trashId],
					excluded: true,
				};
			}

			// Include (un-exclude) only the selected option
			newCustomizations[selectedTrashId] = {
				...newCustomizations[selectedTrashId],
				excluded: false,
			};

			return newCustomizations;
		});
	};

	// Validate score ranges (typical range for Sonarr/Radarr is -10000 to 10000)
	const validateScore = (score: number): { isValid: boolean; warning?: string } => {
		if (score < -10000 || score > 10000) {
			return {
				isValid: false,
				warning: 'Score must be between -10,000 and 10,000'
			};
		}
		if (score < -1000) {
			return {
				isValid: true,
				warning: 'Very low score - heavily penalizes releases'
			};
		}
		if (score > 1000) {
			return {
				isValid: true,
				warning: 'Very high score - strongly prioritizes releases'
			};
		}
		return { isValid: true };
	};

	// Detect mutually exclusive conflicts
	// Copy/Paste functionality
	const handleCopyCustomizations = React.useCallback(() => {
		try {
			const customizationsData = JSON.stringify(customizations, null, 2);
			navigator.clipboard.writeText(customizationsData);
			toast.success("Copied!", {
				description: `Copied ${Object.keys(customizations).length} customization(s) to clipboard`,
			});
		} catch (error) {
			toast.error("Copy Failed", {
				description: "Failed to copy customizations to clipboard",
			});
		}
	}, [customizations]);

	const handlePasteCustomizations = React.useCallback(async () => {
		try {
			const clipboardText = await navigator.clipboard.readText();
			const parsedData = JSON.parse(clipboardText);

			// Validate structure
			if (typeof parsedData !== 'object' || parsedData === null) {
				throw new Error('Invalid format: expected an object');
			}

			// Validate each customization entry
			for (const [trashId, settings] of Object.entries(parsedData)) {
				if (typeof settings !== 'object') {
					throw new Error(`Invalid settings for ${trashId}`);
				}
				const { excluded, scoreOverride } = settings as any;
				if (excluded !== undefined && typeof excluded !== 'boolean') {
					throw new Error(`Invalid 'excluded' value for ${trashId}`);
				}
				if (scoreOverride !== undefined && typeof scoreOverride !== 'number') {
					throw new Error(`Invalid 'scoreOverride' value for ${trashId}`);
				}
			}

			// Apply customizations
			setCustomizations(parsedData as Record<string, CustomizationSettings>);
			toast.success("Pasted!", {
				description: `Applied ${Object.keys(parsedData).length} customization(s) from clipboard`,
			});
		} catch (error) {
			toast.error("Paste Failed", {
				description: error instanceof Error ? error.message : "Failed to paste customizations",
			});
		}
	}, []);


	const detectMutuallyExclusiveConflicts = React.useMemo(() => {
		const conflicts = new Map<string, string[]>(); // groupName -> [trashIds with issues]

		semanticCategoryMap.forEach((categoryData) => {
			categoryData.mutuallyExclusiveGroups.forEach((formats, groupName) => {
				// Find all non-excluded formats in this group
				const activeFormats = formats.filter(f => {
					const customization = customizations[f.trashId];
					return !customization?.excluded && f.isActive;
				});

				// Conflict if more than 1 format is active
				if (activeFormats.length > 1) {
					conflicts.set(groupName, activeFormats.map(f => f.trashId));
				}
			});
		});

		return conflicts;
	}, [semanticCategoryMap, customizations]);

	// Update score
	const updateScore = (trashId: string, score: number | undefined) => {
		setCustomizations(prev => {
			const current = prev[trashId] || {};
			if (score === undefined) {
				const { scoreOverride, ...rest } = current;
				if (Object.keys(rest).length === 0) {
					const { [trashId]: _, ...remaining } = prev;
					return remaining;
				}
				return { ...prev, [trashId]: rest };
			}
			return { ...prev, [trashId]: { ...current, scoreOverride: score } };
		});
	};


	// Bulk actions for category/group
	const includeAllInGroup = (formats: EnrichedFormatItem[]) => {
		setCustomizations((prev) => {
			const updated = { ...prev };
			for (const format of formats) {
				updated[format.trashId] = {
					...updated[format.trashId],
					excluded: false,
				};
			}
			return updated;
		});
	};

	const excludeAllInGroup = (formats: EnrichedFormatItem[]) => {
		setCustomizations((prev) => {
			const updated = { ...prev };
			for (const format of formats) {
				updated[format.trashId] = {
					...updated[format.trashId],
					excluded: true,
				};
			}
			return updated;
		});
	};

	const resetAllScoresInGroup = (formats: EnrichedFormatItem[]) => {
		setCustomizations((prev) => {
			const updated = { ...prev };
			for (const format of formats) {
				if (updated[format.trashId]) {
					updated[format.trashId] = {
						...updated[format.trashId],
						scoreOverride: undefined,
					};
				}
			}
			return updated;
		});
	};

	// Count customizations
	const customizedCount = Object.values(customizations).filter(c =>
		c.excluded || c.scoreOverride !== undefined
	).length;

	const excludedCount = Object.values(customizations).filter(c => c.excluded).length;

	const recommendedCount = formatItems.filter(f => f.isRecommended).length;

	// Count mutually exclusive groups (unique groups with isMutuallyExclusive)
	const mutuallyExclusiveGroups = new Set(
		formatItems
			.filter(f => f.isMutuallyExclusive && f.cfGroup)
			.map(f => f.cfGroup!)
	);
	const mutuallyExclusiveGroupCount = mutuallyExclusiveGroups.size;

	// Preview handler
	const handlePreview = async () => {
		setIsLoadingPreview(true);
		try {
			// Transform customizations to API format
			const excludedCFs = Object.entries(customizations)
				.filter(([_, settings]) => settings.excluded)
				.map(([trashId]) => trashId);

			const scoreOverrides = Object.entries(customizations)
				.filter(([_, settings]) => settings.scoreOverride !== undefined)
				.reduce((acc, [trashId, settings]) => {
					acc[trashId] = settings.scoreOverride!;
					return acc;
				}, {} as Record<string, number>);

			const response = await previewQualityProfile({
				instanceId,
				profileFileName: profile.fileName,
				customizations: {
					excludedCFs: excludedCFs.length > 0 ? excludedCFs : undefined,
					scoreOverrides: Object.keys(scoreOverrides).length > 0 ? scoreOverrides : undefined,
					minFormatScore: profile.minFormatScore,
					cutoffFormatScore: profile.cutoffFormatScore,
				},
			});

			if (response.success && response.diffPlan) {
				setDiffPlan(response.diffPlan);
				setPreviewMode(true);
			} else {
				toast.error(response.error || "Failed to generate preview");
			}
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to preview changes");
		} finally {
			setIsLoadingPreview(false);
		}
	};

	// Back to customization from preview
	const handleBackToCustomization = () => {
		setPreviewMode(false);
		setDiffPlan(null);
	};

	// Approve and apply changes
	const handleApproveAndApply = async () => {
		const cleanedCustomizations = Object.fromEntries(
			Object.entries(customizations).filter(([_, settings]) =>
				settings.excluded || settings.scoreOverride !== undefined
			)
		);
		await onApply(cleanedCustomizations);
	};

	const handleApply = async () => {
		const cleanedCustomizations = Object.fromEntries(
			Object.entries(customizations).filter(([_, settings]) =>
				settings.excluded || settings.scoreOverride !== undefined
			)
		);
		await onApply(cleanedCustomizations);
	};

	// Keyboard shortcuts
	useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			// Skip if user is typing in an input field
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
				return;
			}

			// Ctrl/Cmd + S to save
			if ((e.ctrlKey || e.metaKey) && e.key === 's') {
				e.preventDefault();
				handleApply();
			}

			// Ctrl/Cmd + F to focus search
			if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
				e.preventDefault();
				document.getElementById('cf-search-input')?.focus();
			}

			// Escape to close (handled by Dialog, but we can add custom logic)
			if (e.key === 'Escape') {
				// Dialog will handle closing
			}

			// Ctrl/Cmd + Shift + C to clear filters
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
				e.preventDefault();
				setStatusFilter('all');
				setCategoryFilter('all');
				setSearchQuery('');
			}

			// ? to show help (keyboard shortcuts)
			if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
				e.preventDefault();
				setShowHelpText(prev => !prev);
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [isOpen, handleApply]);

	// Compute changes summary for preview
	const changesSummary = React.useMemo(() => {
		const changes = {
			excluded: [] as { name: string; trashId: string }[],
			scoreOverrides: [] as { name: string; trashId: string; oldScore: number; newScore: number }[],
			included: [] as { name: string; trashId: string }[],
		};

		for (const [trashId, customization] of Object.entries(customizations)) {
			const format = formatItems.find(f => f.trashId === trashId);
			if (!format) continue;

			if (customization.excluded) {
				changes.excluded.push({ name: format.name, trashId });
			} else if (customization.scoreOverride !== undefined) {
				changes.scoreOverrides.push({
					name: format.name,
					trashId,
					oldScore: format.defaultScore,
					newScore: customization.scoreOverride,
				});
			}
		}

		return changes;
	}, [customizations, formatItems]);

	// Show preview mode if active
	if (previewMode && diffPlan) {
		return (
			<Dialog open={isOpen} onOpenChange={onClose} size="xl">
				<DialogHeader className="border-b border-border bg-gradient-to-r from-primary/5 to-transparent">
					<div className="flex items-center justify-between">
						<DialogTitle className="text-2xl font-bold">
							Preview Changes: {profile.name}
						</DialogTitle>
						<button
							type="button"
							onClick={onClose}
							className="text-fg-muted hover:text-fg transition-colors text-3xl font-light"
							disabled={isApplying}
							aria-label="Close preview"
						>
							×
						</button>
					</div>
				</DialogHeader>
				<DialogContent className="p-6 max-h-[70vh] overflow-y-auto">
					<QualityProfileDiffPreview
						diffPlan={diffPlan}
						onApprove={handleApproveAndApply}
						onCancel={handleBackToCustomization}
						isApplying={isApplying}
					/>
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Dialog open={isOpen} onOpenChange={onClose} size="xl">
			<DialogHeader className="border-b border-border bg-gradient-to-r from-primary/5 to-transparent">
					<div className="flex items-start justify-between mb-4">
						<div className="flex-1">
							<DialogTitle className="text-2xl font-bold mb-2">
								Customize: {profile.name}
							</DialogTitle>
							<p className="text-sm text-fg-muted max-w-3xl">
								Review and adjust the custom format scores for this quality profile.
								TRaSH Guides provides recommended scores, but you can customize them to match your preferences.
							</p>
							{profile.trash_description && (
								<div className="mt-3 p-3 bg-primary/10 border border-primary/20 rounded-lg">
									<div
										className="text-xs text-fg-muted"
										dangerouslySetInnerHTML={{ __html: profile.trash_description }}
									/>
								</div>
							)}
							{profile.trash_guide_url && (
								<div className="mt-3 flex items-center gap-2">
									<svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
									</svg>
									<span className="text-xs text-fg-muted">
										For detailed setup instructions, see the{" "}
										<a
											href={profile.trash_guide_url}
											target="_blank"
											rel="noopener noreferrer"
											className="text-primary hover:underline font-medium"
										>
											TRaSH Guides documentation
										</a>
									</span>
								</div>
							)}
						</div>

						{/* Quick Preset Buttons */}
						<div className="flex flex-col gap-2 ml-4">
							<button
								type="button"
								onClick={() => {
									// Apply "Recommended Only" preset
									const newCustomizations: Record<string, CustomizationSettings> = {};
									formatItems.forEach(format => {
										if (!format.isRecommended) {
											newCustomizations[format.trashId] = { excluded: true };
										}
									});
									setCustomizations(newCustomizations);
								}}
								className="text-xs px-3 py-1.5 rounded bg-success/10 text-success hover:bg-success/20 border border-success/30 transition-colors whitespace-nowrap"
								title="Include only recommended formats, exclude all others"
								aria-label="Apply recommended only preset"
							>
								✓ Recommended Only
							</button>
							<button
								type="button"
								onClick={() => {
									// Apply "Include All" preset
									setCustomizations({});
								}}
								className="text-xs px-3 py-1.5 rounded bg-primary/10 text-primary hover:bg-primary/20 border border-primary/30 transition-colors whitespace-nowrap"
								title="Include all formats (clear all exclusions and overrides)"
								aria-label="Apply include all preset"
							>
								⊕ Include All
							</button>
							<button
								type="button"
								onClick={() => {
									// Reset to TRaSH defaults
									setCustomizations({});
									setSearchQuery("");
									setStatusFilter('all');
									setCategoryFilter('all');
								}}
								className="text-xs px-3 py-1.5 rounded bg-warning/10 text-warning hover:bg-warning/20 border border-warning/30 transition-colors whitespace-nowrap"
								title="Reset all customizations to TRaSH Guide defaults"
								aria-label="Reset to defaults"
							>
								↺ Reset to Defaults
							</button>

							{/* Divider */}
							<div className="border-t border-border my-2" />

							{/* Copy/Paste Buttons */}
							<button
								type="button"
								onClick={handleCopyCustomizations}
								className="text-xs px-3 py-1.5 rounded bg-accent/10 text-accent hover:bg-accent/20 border border-accent/30 transition-colors whitespace-nowrap flex items-center gap-1.5"
								title="Copy current customizations to clipboard"
								aria-label="Copy customizations"
							>
								<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
								</svg>
								Copy
							</button>
							<button
								type="button"
								onClick={handlePasteCustomizations}
								className="text-xs px-3 py-1.5 rounded bg-accent/10 text-accent hover:bg-accent/20 border border-accent/30 transition-colors whitespace-nowrap flex items-center gap-1.5"
								title="Paste customizations from clipboard"
								aria-label="Paste customizations"
							>
								<svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
								</svg>
								Paste
							</button>
						</div>

						<button
							type="button"
							onClick={onClose}
							className="text-fg-muted hover:text-fg transition-colors text-3xl font-light ml-4"
							disabled={isApplying}
							aria-label="Close customization modal"
						>
							×
						</button>
					</div>

					{/* Summary Stats - Compact */}
					<div className="flex flex-wrap gap-2 text-xs">
						<span className="text-fg-muted">
							<strong className="text-fg">{formatItems.length}</strong> total
						</span>
						{recommendedCount > 0 && (
							<>
								<span className="text-fg-muted">•</span>
								<span className="text-success">
									<strong>{recommendedCount}</strong> recommended
								</span>
							</>
						)}
						{mutuallyExclusiveGroupCount > 0 && (
							<>
								<span className="text-fg-muted">•</span>
								<span className="text-warning">
									⚠ <strong>{mutuallyExclusiveGroupCount}</strong> pick-one group{mutuallyExclusiveGroupCount > 1 ? 's' : ''}
								</span>
							</>
						)}
						{customizedCount > 0 && (
							<>
								<span className="text-fg-muted">•</span>
								<span className="text-primary">
									<strong>{customizedCount}</strong> customized
								</span>
							</>
						)}
						{excludedCount > 0 && (
							<>
								<span className="text-fg-muted">•</span>
								<span className="text-danger">
									<strong>{excludedCount}</strong> excluded
								</span>
							</>
						)}
					</div>
			</DialogHeader>

			<DialogContent className="p-0">
				{/* Search & Controls - Sticky Header */}
				<div className="sticky top-0 z-10 p-4 border-b border-border bg-bg-subtle/95 backdrop-blur-sm space-y-3 shadow-sm">
					{/* Search Row */}
					<div className="flex gap-2 items-center">
						<div className="flex-1">
							<label htmlFor="cf-search-input" className="sr-only">
								Search custom formats by name or trash ID
							</label>
							<Input
								id="cf-search-input"
								type="text"
								placeholder="Search custom formats..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="w-full"
								aria-describedby="search-results-count"
							/>
						</div>
						<Button
							variant={showInactiveCFs ? "primary" : "secondary"}
							size="sm"
							onClick={() => setShowInactiveCFs(!showInactiveCFs)}
							className="whitespace-nowrap"
							aria-pressed={showInactiveCFs}
							aria-label={`${showInactiveCFs ? "Hide" : "Show"} inactive custom formats. ${formatItems.filter(f => !f.isActive && !f.isRecommended).length} inactive formats available.`}
						>
							{showInactiveCFs ? "Hide" : "Show"} Inactive ({formatItems.filter(f => !f.isActive && !f.isRecommended).length})
						</Button>
						<button
							type="button"
							onClick={() => setShowHelpText(!showHelpText)}
							className="p-2 text-primary hover:bg-primary/10 rounded-lg transition-colors"
							aria-label={showHelpText ? "Hide scoring help text" : "Show scoring help text"}
							aria-expanded={showHelpText}
							aria-controls="help-text-section"
						>
							<svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
							</svg>
						</button>
					</div>

					{/* Filter Row */}
					<div className="flex gap-2 items-center flex-wrap">
						{/* Status Filter */}
						<div className="flex-1 min-w-[200px]">
							<label htmlFor="status-filter" className="sr-only">
								Filter by status
							</label>
							<select
								id="status-filter"
								value={statusFilter}
								onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
								className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-fg text-sm focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
								aria-label="Filter custom formats by status"
							>
								<option value="all">All Status</option>
								<option value="recommended">Recommended Only</option>
								<option value="active">Active Only</option>
								<option value="excluded">Excluded Only</option>
								<option value="overridden">With Score Override</option>
							</select>
						</div>

						{/* Category Filter */}
						<div className="flex-1 min-w-[200px]">
							<label htmlFor="category-filter" className="sr-only">
								Filter by category
							</label>
							<select
								id="category-filter"
								value={categoryFilter}
								onChange={(e) => setCategoryFilter(e.target.value)}
								className="w-full px-3 py-2 bg-bg border border-border rounded-lg text-fg text-sm focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
								aria-label="Filter custom formats by category"
							>
								<option value="all">All Categories</option>
								{availableCategories.map(cat => (
									<option key={cat} value={cat}>{cat}</option>
								))}
							</select>
						</div>

						{/* Clear Filters Button */}
						{(statusFilter !== 'all' || categoryFilter !== 'all' || searchQuery) && (
							<Button
								variant="ghost"
								size="sm"
								onClick={() => {
									setStatusFilter('all');
									setCategoryFilter('all');
									setSearchQuery('');
								}}
								className="whitespace-nowrap"
								aria-label="Clear all filters"
							>
								<svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
									<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
								</svg>
								Clear Filters
							</Button>
						)}

						{/* Results Count */}
						<div id="search-results-count" className="text-xs text-fg-muted whitespace-nowrap">
							Showing <strong className="text-primary">{filteredFormats.length}</strong> of <strong>{formatItems.length}</strong> formats
						</div>
					</div>

					{/* Collapsible Help Text */}
					{showHelpText && (
						<div
							id="help-text-section"
							className="flex items-start gap-2 p-3 bg-primary/10 rounded-lg border border-primary/30"
							role="region"
							aria-label="Scoring help information"
						>
							<svg className="w-4 h-4 text-primary shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
							</svg>
							<div className="text-xs text-primary space-y-2">
								<div>
									<p className="font-semibold">How Scoring Works:</p>
									<p>Higher scores = more likely to download. Negative scores = avoid these releases.</p>
									<p>Your final score must be between the min and cutoff values defined in this quality profile.</p>
								</div>
								<div className="pt-2 border-t border-primary/20">
									<p className="font-semibold mb-1">Keyboard Shortcuts:</p>
									<div className="grid grid-cols-2 gap-x-4 gap-y-1">
										<div><kbd className="px-1.5 py-0.5 bg-primary/20 rounded text-xs">Ctrl/⌘ + S</kbd> Save changes</div>
										<div><kbd className="px-1.5 py-0.5 bg-primary/20 rounded text-xs">Ctrl/⌘ + F</kbd> Focus search</div>
										<div><kbd className="px-1.5 py-0.5 bg-primary/20 rounded text-xs">Ctrl/⌘ + ⇧ + C</kbd> Clear filters</div>
										<div><kbd className="px-1.5 py-0.5 bg-primary/20 rounded text-xs">?</kbd> Toggle help</div>
									</div>
								</div>
							</div>
						</div>
					)}
				</div>

				{/* Formats List */}
				<div className="flex-1 overflow-y-auto" role="main" aria-label="Custom formats list">
					<div className="p-4">
						{/* Screen reader live region for search results count */}
						<div
							id="search-results-count"
							className="sr-only"
							role="status"
							aria-live="polite"
							aria-atomic="true"
						>
							{searchQuery && `${filteredFormats.length} custom format${filteredFormats.length === 1 ? '' : 's'} found matching "${searchQuery}"`}
						</div>

						{isLoadingFormats ? (
							<div className="space-y-6 px-4" role="status" aria-label="Loading custom formats">
								{/* Loading State - Skeleton for categories */}
								{[1, 2, 3].map(catIndex => (
									<div key={catIndex} className="space-y-4">
										{/* Category Header Skeleton */}
										<div className="flex items-center gap-3 py-2 border-b-2 border-primary/30">
											<div className="flex-1">
												<Skeleton className="h-5 w-32" />
											</div>
											<div className="flex items-center gap-2">
												<Skeleton className="h-7 w-24" />
												<Skeleton className="h-7 w-24" />
												<Skeleton className="h-7 w-24" />
											</div>
										</div>

										{/* Mutually Exclusive Group Skeleton */}
										{catIndex === 1 && (
											<div className="border-2 border-warning/30 rounded-xl p-4 bg-warning/5">
												<div className="flex items-center gap-3 mb-3 pb-3 border-b border-warning/20">
													<div className="w-5 h-5 bg-warning/30 rounded flex-shrink-0" />
													<div className="flex-1">
														<Skeleton className="h-4 w-40 mb-2" />
														<Skeleton className="h-3 w-64" />
													</div>
												</div>
												<div className="space-y-3">
													{[1, 2].map(optionIndex => (
														<div key={optionIndex} className="flex items-start gap-3 p-3 rounded-lg bg-bg-subtle/50 border border-border">
															<div className="w-5 h-5 bg-border rounded-full flex-shrink-0 mt-0.5" />
															<div className="flex-1">
																<Skeleton className="h-4 w-48 mb-2" />
																<Skeleton className="h-3 w-full mb-1" />
																<Skeleton className="h-3 w-3/4" />
															</div>
														</div>
													))}
												</div>
											</div>
										)}

										{/* Format Cards Skeleton */}
										<div className="space-y-3">
											{[1, 2].map(formatIndex => (
												<Card key={formatIndex} className="hover:border-primary/30">
													<div className="p-4">
														<div className="flex items-start gap-3 mb-3">
															<div className="w-5 h-5 bg-border rounded flex-shrink-0 mt-0.5" />
															<div className="flex-1 min-w-0">
																<div className="flex items-center gap-2 flex-wrap mb-1">
																	<Skeleton className="h-5 w-40" />
																	<Skeleton className="h-5 w-16" />
																</div>
																<Skeleton className="h-3 w-full mb-1" />
																<Skeleton className="h-3 w-2/3" />
															</div>
														</div>
														<div className="flex items-center gap-4 flex-wrap">
															<div className="flex items-center gap-2">
																<Skeleton className="h-3 w-12" />
																<Skeleton className="h-8 w-20" />
															</div>
															<Skeleton className="h-8 w-16" />
														</div>
													</div>
												</Card>
											))}
										</div>
									</div>
								))}
							</div>
						) : filteredFormats.length === 0 ? (
							<div className="flex items-center justify-center py-16">
								<div className="text-center">
									<p className="text-fg-muted mb-2">
										{searchQuery ? "No formats match your search" : "No formats found"}
									</p>
									{searchQuery && (
										<button
											onClick={() => setSearchQuery("")}
											className="text-sm text-primary hover:underline"
											aria-label="Clear search query"
										>
											Clear search
										</button>
									)}
								</div>
							</div>
						) : (
							<>
								{/* Format Cards - Grouped by Semantic Category */}
								<div className="space-y-6">
									{/* Render each semantic category */}
									{Array.from(semanticCategoryMap.entries()).map(([categoryName, categoryData]) => (
										<section key={categoryName} className="space-y-4" aria-labelledby={`category-${categoryName.replace(/\s+/g, '-')}`}>
											{/* Semantic Category Header */}
											<div className="flex items-center gap-3 py-2 border-b-2 border-primary/30">
												<div className="flex-1 flex items-center gap-2">
													<h3 id={`category-${categoryName.replace(/\s+/g, '-')}`} className="text-sm font-bold text-primary uppercase tracking-wide">
														{categoryName}
													</h3>
													<Badge variant="secondary" className="text-xs">
														{categoryData.mutuallyExclusiveGroups.size + categoryData.regularFormats.length} formats
													</Badge>
												</div>
												{/* Bulk actions for category - only apply to regular (non-mutually-exclusive) formats */}
												{categoryData.regularFormats.length > 0 && (
													<div className="flex items-center gap-2" role="group" aria-label={`Bulk actions for ${categoryName}`}>
														<button
															type="button"
															onClick={() => includeAllInGroup(categoryData.regularFormats)}
															className="text-xs px-3 py-1 rounded bg-success/10 text-success hover:bg-success/20 border border-success/30 transition-colors"
															aria-label={`Include all custom formats in ${categoryName}`}
														>
															Include All
														</button>
														<button
															type="button"
															onClick={() => excludeAllInGroup(categoryData.regularFormats)}
															className="text-xs px-3 py-1 rounded bg-danger/10 text-danger hover:bg-danger/20 border border-danger/30 transition-colors"
															aria-label={`Exclude all custom formats in ${categoryName}`}
														>
															Exclude All
														</button>
														<button
															type="button"
															onClick={() => resetAllScoresInGroup(categoryData.regularFormats)}
															className="text-xs px-3 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 border border-primary/30 transition-colors"
															aria-label={`Reset all scores to defaults in ${categoryName}`}
														>
															Reset Scores
														</button>
													</div>
												)}
											</div>

											{/* Mutually exclusive groups within this category */}
											{Array.from(categoryData.mutuallyExclusiveGroups.entries()).map(([groupName, groupFormats]) => (
										<div key={groupName} className={`border-2 rounded-xl p-4 ${
										detectMutuallyExclusiveConflicts.has(groupName)
											? 'border-danger bg-danger/10'
											: 'border-warning/30 bg-warning/5'
									}`}>
											{/* Group Header */}
											<div className="flex items-center gap-3 mb-3 pb-3 border-b border-warning/20">
												<svg className={`w-5 h-5 flex-shrink-0 ${
											detectMutuallyExclusiveConflicts.has(groupName) ? 'text-danger' : 'text-warning'
										}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
													<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
												</svg>
												<div className="flex-1">
													<h4 className="font-semibold text-fg text-sm">{groupName}</h4>
													<p className="text-xs text-fg-muted mt-0.5">
														<span className={`font-medium ${
												detectMutuallyExclusiveConflicts.has(groupName) ? 'text-danger' : 'text-warning'
											}`}>Pick ONE option</span> that matches your setup. Only one can be active.
													</p>
													{groupFormats[0]?.cfGroupDescription && (
														<div
															className="mt-2 text-xs text-fg-muted leading-relaxed"
															dangerouslySetInnerHTML={{ __html: sanitizeHtml(groupFormats[0].cfGroupDescription) }}
														/>
													)}
												</div>
											</div>

											{/* Group Options - Proper Radio Group */}
											<div
												role="radiogroup"
												aria-label={groupName}
												className="space-y-3"
												onKeyDown={(e) => {
													// Arrow key navigation for radio groups (WAI-ARIA pattern)
													if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
														e.preventDefault();
														const currentIndex = groupFormats.findIndex(f => !customizations[f.trashId]?.excluded);
														const nextIndex = (currentIndex + 1) % groupFormats.length;
														toggleMutuallyExclusiveOption(groupFormats[nextIndex].trashId, groupName);
														// Focus the next radio button
														setTimeout(() => {
															const radioId = `radio-${groupName.replace(/\s+/g, '-')}-${groupFormats[nextIndex].trashId}`;
															document.getElementById(radioId)?.focus();
														}, 0);
													} else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
														e.preventDefault();
														const currentIndex = groupFormats.findIndex(f => !customizations[f.trashId]?.excluded);
														const prevIndex = (currentIndex - 1 + groupFormats.length) % groupFormats.length;
														toggleMutuallyExclusiveOption(groupFormats[prevIndex].trashId, groupName);
														// Focus the previous radio button
														setTimeout(() => {
															const radioId = `radio-${groupName.replace(/\s+/g, '-')}-${groupFormats[prevIndex].trashId}`;
															document.getElementById(radioId)?.focus();
														}, 0);
													}
												}}
											>
												{groupFormats.map((format, index) => {
													const customization = customizations[format.trashId];
													const isSelected = !customization?.excluded;
													const hasOverride = customization?.scoreOverride !== undefined;
													const displayScore = customization?.scoreOverride ?? format.defaultScore;
													const radioId = `radio-${groupName.replace(/\s+/g, '-')}-${format.trashId}`;
															const isInConflict = detectMutuallyExclusiveConflicts.get(groupName)?.includes(format.trashId) || false;

													return (
														<Card
															key={format.trashId}
															onClick={() => toggleMutuallyExclusiveOption(format.trashId, groupName)}
															className={`cursor-pointer transition-all ${
																isInConflict
																	? 'border-danger bg-danger/10 shadow-md hover:shadow-lg ring-2 ring-danger/50'
																	: isSelected
																	? 'border-success bg-success/10 shadow-md hover:shadow-lg'
																	: 'border-border/50 hover:border-warning/50 hover:bg-warning/5'
															}`}
														>
															<div className="p-4">
																{/* Card Header: Radio + Title + Badges */}
																<div className="flex items-start gap-3 mb-3">
																	{/* Radio Button */}
																	<div className="flex items-center pt-0.5">
																		<input
																			type="radio"
																			id={radioId}
																			name={`mutually-exclusive-${groupName}`}
																			checked={isSelected}
																			onChange={() => toggleMutuallyExclusiveOption(format.trashId, groupName)}
																			onClick={(e) => e.stopPropagation()}
																			className="w-5 h-5 cursor-pointer"
																			aria-label={format.name}
																			tabIndex={index === 0 || isSelected ? 0 : -1}
																		/>
																	</div>

																	{/* Format Name + Badges */}
																	<div className="flex-1 min-w-0">
																		<div className="flex items-center gap-2 flex-wrap mb-1">
																			<h4 className={`font-semibold text-base ${isSelected ? 'text-success' : 'text-fg'}`}>
																				{format.name}
																				{isSelected && (
																					<span className="ml-2 text-xs font-normal text-success/80">(Selected)</span>
																				)}
																			</h4>
																			{format.default && (
																				<Badge variant="primary" className="text-xs px-2 py-0.5">
																					Default
																				</Badge>
																			)}
																			{format.required && (
																				<Badge variant="success" className="text-xs px-2 py-0.5">
																					Required
																				</Badge>
																			)}
																		</div>
																		{format.description && (
																			<div className="text-xs text-fg-muted line-clamp-2">
																				{format.description.replace(/<[^>]*>/g, '').substring(0, 120)}...
																			</div>
																		)}
																	</div>
																</div>

																{/* Card Body: Scores */}
																<div className="flex items-center gap-4 flex-wrap">
																	{/* TRaSH Score */}
																	<div className="flex items-center gap-2">
																		<span className="text-xs font-medium text-fg-subtle uppercase tracking-wide">TRaSH Score:</span>
																		<Badge variant="default" className="text-lg font-bold bg-bg-subtle">
																			{format.defaultScore}
																		</Badge>
																	</div>

																	{/* Your Score */}
																	<div className="flex items-center gap-2">
																		<span className="text-xs font-medium text-fg-subtle uppercase tracking-wide">Your Score:</span>
																		<div className="flex items-center gap-1">
																			<input
																				type="number"
																				value={displayScore}
																				onChange={(e) => updateScore(format.trashId, e.target.value === '' ? undefined : Number.parseInt(e.target.value))}
																				onClick={(e) => e.stopPropagation()}
																				className={`w-24 px-3 py-2 rounded-lg border text-center font-bold ${
																					hasOverride
																				? (() => {
																					const validation = validateScore(displayScore);
																					return !validation.isValid
																						? 'border-danger bg-danger/10 text-danger focus:ring-danger/50'
																						: validation.warning
																						? 'border-warning bg-warning/10 text-warning focus:ring-warning/50'
																						: 'border-primary bg-primary/10 text-primary focus:ring-primary/50';
																				})()
																											: ''
																				}`}
																				disabled={!isSelected}
																			/>
																			{hasOverride && isSelected && (
																				<button
																					type="button"
																					onClick={(e) => {
																						e.stopPropagation();
																						updateScore(format.trashId, undefined);
																					}}
																					className="text-xs text-primary hover:text-danger px-2 py-1 rounded hover:bg-danger/10 whitespace-nowrap"
																					title="Reset to TRaSH default"
																				>
																					Reset
																				</button>
																			)}
																		</div>
																	</div>
																</div>
															</div>
														</Card>
													);
												})}
											</div>
										</div>
											))}

											{/* Regular formats within this category */}
											{categoryData.regularFormats.map((format) => {
										const customization = customizations[format.trashId];
										const isExcluded = customization?.excluded || false;
										const hasOverride = customization?.scoreOverride !== undefined;
										const displayScore = customization?.scoreOverride ?? format.defaultScore;

										return (
											<Card
												key={format.trashId}
												className={`transition-all ${
													isExcluded
														? 'border-danger/50 bg-danger/5 opacity-60'
														: hasOverride
														? 'border-primary/50 bg-primary/5'
														: 'hover:border-primary/30 hover:bg-bg-subtle/50'
												}`}
											>
												<div className="p-4">
													{/* Card Header: Checkbox + Title + Badges */}
													<div className="flex items-start gap-3 mb-3">
														{/* Action: Include/Exclude Checkbox */}
														<div className="flex items-center pt-0.5">
															<input
																type="checkbox"
																id={`cf-checkbox-${format.trashId}`}
																checked={!isExcluded}
																onChange={() => toggleExclude(format.trashId)}
																className="w-5 h-5 rounded border-border cursor-pointer"
																aria-label={isExcluded ? `Include ${format.name} custom format` : `Exclude ${format.name} custom format`}
															/>
														</div>

														{/* Format Name + Badges */}
														<div className="flex-1 min-w-0">
															<div className="flex items-center gap-2 flex-wrap mb-1">
																<h4 className={`font-semibold text-base ${isExcluded ? 'line-through text-fg-muted' : 'text-fg'}`}>
																	{format.name}
																</h4>
																{format.required && (
																	<Badge variant="success" className="text-xs px-2 py-0.5">
																		Required
																	</Badge>
																)}
																{format.default && !format.required && (
																	<Badge variant="primary" className={`text-xs px-2 py-0.5 ${isExcluded ? 'opacity-60' : ''}`}>
																		Default
																	</Badge>
																)}
																{format.isRecommended && !format.required && !format.default && (
																	<Badge variant="primary" className={`text-xs px-2 py-0.5 ${isExcluded ? 'opacity-60' : ''}`}>
																		Recommended
																	</Badge>
																)}
																{format.isOptional && !format.required && (
																	<Badge variant="secondary" className={`text-xs px-2 py-0.5 ${isExcluded ? 'opacity-60' : ''}`}>
																		Optional
																	</Badge>
																)}
																{format.isMutuallyExclusive && !format.required && (
																	<Badge variant="warning" className={`text-xs px-2 py-0.5 ${isExcluded ? 'opacity-60' : ''}`}>
																		Pick One
																	</Badge>
																)}
																{format.defaultScore < 0 && (
																	<Badge variant="danger" className={`text-xs px-2 py-0.5 ${isExcluded ? 'opacity-60' : ''}`}>
																		Unwanted
																	</Badge>
																)}
																{!isExcluded && (
																	<button
																		type="button"
																		onClick={() => {
																			const expandedSet = new Set(expandedDescriptions);
																			if (expandedSet.has(format.trashId)) {
																				expandedSet.delete(format.trashId);
																			} else {
																				expandedSet.add(format.trashId);
																			}
																			setExpandedDescriptions(expandedSet);
																		}}
																		className="text-primary hover:text-primary/80 transition-colors ml-auto"
																		aria-label={expandedDescriptions.has(format.trashId) ? `Hide details for ${format.name}` : `Show details for ${format.name}`}
													aria-expanded={expandedDescriptions.has(format.trashId)}
													aria-controls={`cf-description-${format.trashId}`}
																	>
																		<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
																			<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
																		</svg>
																	</button>
																)}
															</div>
															<div className="flex items-center gap-2 text-xs text-fg-muted">
																<span className="font-mono">{format.trashId}</span>
																{format.cfGroup && (
																	<>
																		<span>•</span>
																		<span className={isExcluded ? 'opacity-60' : ''}>
																			from {format.cfGroup}
																		</span>
																	</>
																)}
															</div>
														</div>
													</div>

													{/* Card Body: Scores */}
													<div className="flex items-center gap-4 flex-wrap">
														{/* TRaSH Score */}
														<div className="flex items-center gap-2">
															<span className="text-xs font-medium text-fg-subtle uppercase tracking-wide">TRaSH Score:</span>
															<Badge variant="default" className={`text-lg font-bold ${
																format.defaultScore < 0
																	? 'bg-danger/20 text-danger border-danger/30'
																	: format.defaultScore === 0
																		? 'bg-bg-muted text-fg-muted'
																		: format.defaultScore > 100
																			? 'bg-success/20 text-success border-success/30'
																			: 'bg-primary/20 text-primary border-primary/30'
															}`}>
																{format.defaultScore}
															</Badge>
														</div>

														{/* Your Score */}
														{!isExcluded ? (
																			<div className="flex flex-col gap-1">
																				<div className="flex items-center gap-2">
																<label htmlFor={`score-input-${format.trashId}`} className="text-xs font-medium text-fg-subtle uppercase tracking-wide">Your Score:</label>
																<div className="flex items-center gap-1">
																	<Input
																		id={`score-input-${format.trashId}`}
																		type="number"
																		value={customization?.scoreOverride ?? ""}
																		onChange={(e) => {
																			const value = e.target.value;
																			updateScore(
																				format.trashId,
																				value === "" ? undefined : Number.parseInt(value, 10)
																			);
																		}}
																		placeholder={format.defaultScore.toString()}
																		className={`w-24 text-center font-bold ${
																			hasOverride
																				? (() => {
																				const validation = validateScore(displayScore);
																				return !validation.isValid
																					? 'border-danger bg-danger/10 text-danger focus:ring-danger/50'
																					: validation.warning
																					? 'border-warning bg-warning/10 text-warning focus:ring-warning/50'
																					: 'border-primary bg-primary/10 text-primary focus:ring-primary/50';
																				})()
																				: ''
																		}`}
																		aria-label={`Custom score for ${format.name}. Default is ${format.defaultScore}.`}
																		aria-describedby={hasOverride ? `reset-btn-${format.trashId}` : undefined}
																			aria-invalid={hasOverride && !validateScore(displayScore).isValid}
																	/>
																	{hasOverride && (
																		<button
																			id={`reset-btn-${format.trashId}`}
																			type="button"
																			onClick={() => updateScore(format.trashId, undefined)}
																			className="text-xs text-primary hover:text-danger px-2 py-1 rounded hover:bg-danger/10 whitespace-nowrap"
																			aria-label={`Reset ${format.name} score to TRaSH default of ${format.defaultScore}`}
																		>
																			Reset
																		</button>
																	)}
																</div>
t														</div>
															{/* Validation Warning Display */}
															{hasOverride && (() => {
																const validation = validateScore(displayScore);
																return validation.warning ? (
																	<div className={`text-xs px-2 py-1 rounded flex items-center gap-1.5 ml-auto ${
																		!validation.isValid
																			? 'bg-danger/20 text-danger border border-danger/30'
																			: 'bg-warning/20 text-warning border border-warning/30'
																	}`}>
																		<span aria-hidden="true">⚠</span>
																		<span>{validation.warning}</span>
																	</div>
																) : null;
															})()}
															</div>
														) : (
															<div className="flex items-center gap-2">
																<span className="text-xs font-medium text-fg-subtle uppercase tracking-wide">Status:</span>
																<Badge variant="danger" className="text-sm font-semibold">EXCLUDED</Badge>
															</div>
														)}
													</div>

													{/* Card Footer: Description Panel (Expandable) */}
													{!isExcluded && expandedDescriptions.has(format.trashId) && (() => {
														// Try to get hardcoded description first, then TRaSH description
														const hardcodedDesc = getCFDescription(format.name);
														const displayDesc = hardcodedDesc || (format.description ? { html: format.description } : null);

														return (
															<div className="mt-3 pt-3 border-t border-border p-3 bg-primary/5 border-l-4 border-l-primary rounded-r">
																<div className="flex items-start gap-2 mb-2">
																	<svg className="w-4 h-4 text-primary shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
																		<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
																	</svg>
																	<span className="text-xs font-semibold text-primary">TRaSH Guide Details:</span>
																</div>
																{displayDesc ? (
																	<>
																		<div
																			className="text-xs text-fg prose prose-xs max-w-none prose-invert prose-p:my-1 prose-ul:my-1 prose-li:my-0.5"
																			dangerouslySetInnerHTML={{ __html: sanitizeHtml(displayDesc.html) }}
																		/>
																		{hardcodedDesc?.source && (
																			<div className="mt-2 pt-2 border-t border-primary/20">
																				<a
																					href={hardcodedDesc.source}
																					target="_blank"
																					rel="noopener noreferrer"
																					className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
																				>
																					<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
																						<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
																					</svg>
																					Read full guide
																				</a>
																			</div>
																		)}
																	</>
																) : (
																	<div className="text-xs text-fg-muted space-y-2">
																		<p>
																			This custom format is from TRaSH Guides. For detailed information about how this format works and when to use it, visit the TRaSH Guides documentation.
																		</p>
																		<a
																			href={`https://trash-guides.info/${service === 'SONARR' ? 'Sonarr' : 'Radarr'}/${service === 'SONARR' ? 'sonarr' : 'radarr'}-collection-of-custom-formats/`}
																			target="_blank"
																			rel="noopener noreferrer"
																			className="inline-flex items-center gap-1 text-primary hover:underline"
																		>
																			<svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
																				<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
																			</svg>
																			View {service} Custom Formats Guide
																		</a>
																	</div>
																)}
															</div>
														);
													})()}
												</div>
											</Card>
												);
											})}
									</section>
									))}
								</div>
							</>
						)}
					</div>
				</div>
			</DialogContent>


			<DialogFooter className="border-t border-border bg-bg-subtle/30 flex-col items-stretch gap-3">
				{/* Changes Preview Toggle */}
				{customizedCount > 0 && (
					<button
						type="button"
						onClick={() => setShowChangesPreview(!showChangesPreview)}
						className="mb-3 w-full text-left px-4 py-2.5 rounded-lg bg-primary/10 border border-primary/30 hover:bg-primary/15 transition-all flex items-center justify-between group"
						aria-expanded={showChangesPreview}
						aria-label="Toggle changes preview"
					>
						<div className="flex items-center gap-2">
							<svg className="w-4 h-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
							</svg>
							<span className="text-sm font-semibold text-primary">
								{showChangesPreview ? 'Hide' : 'Preview'} Changes Summary
							</span>
						</div>
						<svg
							className={`w-5 h-5 text-primary transition-transform duration-200 ${showChangesPreview ? 'rotate-180' : ''}`}
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
						</svg>
					</button>
				)}

				{/* Collapsible Changes Preview */}
				{showChangesPreview && customizedCount > 0 && (
					<div className="mb-3 border border-border rounded-lg bg-bg-subtle/50 overflow-hidden max-h-64 overflow-y-auto">
						{/* Excluded Formats */}
						{changesSummary.excluded.length > 0 && (
							<div className="p-3 border-b border-border">
								<h4 className="text-xs font-semibold text-danger uppercase tracking-wide mb-2 flex items-center gap-1.5">
									<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
									</svg>
									Excluded ({changesSummary.excluded.length})
								</h4>
								<div className="space-y-1">
									{changesSummary.excluded.slice(0, 10).map(item => (
										<div key={item.trashId} className="text-xs text-fg-muted pl-5">
											• {item.name}
										</div>
									))}
									{changesSummary.excluded.length > 10 && (
										<div className="text-xs text-fg-subtle pl-5 italic">
											... and {changesSummary.excluded.length - 10} more
										</div>
									)}
								</div>
							</div>
						)}

						{/* Score Overrides */}
						{changesSummary.scoreOverrides.length > 0 && (
							<div className="p-3">
								<h4 className="text-xs font-semibold text-primary uppercase tracking-wide mb-2 flex items-center gap-1.5">
									<svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
									</svg>
									Score Overrides ({changesSummary.scoreOverrides.length})
								</h4>
								<div className="space-y-1.5">
									{changesSummary.scoreOverrides.slice(0, 10).map(item => (
										<div key={item.trashId} className="text-xs flex items-center justify-between pl-5">
											<span className="text-fg-muted flex-1">{item.name}</span>
											<span className="flex items-center gap-2 font-mono">
												<span className="text-fg-subtle">{item.oldScore}</span>
												<svg className="w-3 h-3 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
													<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
												</svg>
												<span className="text-primary font-semibold">{item.newScore}</span>
											</span>
										</div>
									))}
									{changesSummary.scoreOverrides.length > 10 && (
										<div className="text-xs text-fg-subtle pl-5 italic">
											... and {changesSummary.scoreOverrides.length - 10} more
										</div>
									)}
								</div>
							</div>
						)}
					</div>
				)}

<div className="flex items-center justify-between w-full">
					<div className="text-sm">
						{customizedCount > 0 ? (
							<span className="text-fg-muted">
								<span className="font-semibold text-primary">{customizedCount}</span> customization{customizedCount !== 1 ? 's' : ''} will be saved
							</span>
						) : (
							<span className="text-fg-muted">Using TRaSH default scores for all formats</span>
						)}
					</div>
					<div className="flex gap-2">
							<Button
								variant="ghost"
								onClick={onClose}
								disabled={isApplying || isLoadingPreview}
								className="px-6"
							>
								Cancel
							</Button>
							<Button
								variant="secondary"
								onClick={handlePreview}
								disabled={isApplying || isLoadingPreview}
								className="px-6"
							>
								{isLoadingPreview ? (
									<>
										<svg className="animate-spin -ml-1 mr-2 h-4 w-4" fill="none" viewBox="0 0 24 24">
											<circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
											<path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
										</svg>
										Loading...
									</>
								) : (
									<>
										Preview Changes
										<svg className="ml-2 h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
											<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
											<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
										</svg>
									</>
								)}
							</Button>
					</div>
				</div>

				{/* Help Text */}
				<div className="text-xs text-fg-subtle bg-primary/5 border border-primary/20 rounded-lg p-3">
					<strong className="text-primary">💡 Tip:</strong> Your customizations will be preserved when TRaSH Guides updates.
					Only formats you haven&apos;t customized will be updated with new TRaSH scores.
				</div>
			</DialogFooter>
		</Dialog>
	);
}
