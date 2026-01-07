"use client";

import { useState, useEffect, useMemo } from "react";
import { Button } from "../../../components/ui";
import { X } from "lucide-react";
import type { QualityProfileSummary } from "../../../lib/api-client/trash-guides";
import type { TrashTemplate, CustomQualityConfig } from "@arr/shared";
import { QualityProfileSelection } from "./wizard-steps/quality-profile-selection";
import { QualityConfiguration } from "./wizard-steps/quality-configuration";
import { CFConfiguration } from "./wizard-steps/cf-configuration";
import { CFResolution, type ResolvedCF } from "./wizard-steps/cf-resolution";
import { TemplateCreation } from "./wizard-steps/template-creation";
import { htmlToPlainText } from "../lib/description-utils";
import { convertQualityProfileToConfig, getEffectiveQualityConfig } from "../lib/quality-config-utils";

/**
 * Check if a trashId indicates a cloned profile from an instance
 * Cloned profile trashIds have format: cloned-{instanceId}-{profileId}-{uuid}
 */
function isClonedProfile(trashId: string | undefined): boolean {
	return !!trashId && trashId.startsWith("cloned-");
}

/**
 * Parse cloned profile trashId to extract instanceId and profileId
 * Format: cloned-{instanceId}-{profileId}-{uuid}
 * Where instanceId can contain dashes, profileId is a number, and uuid can be:
 * - Standard UUID: 5 parts (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
 * - Fallback: 2 parts (timestamp-random alphanumeric)
 */
function parseClonedProfileId(trashId: string): { instanceId: string; profileId: number } | null {
	if (!isClonedProfile(trashId)) return null;

	// Remove "cloned-" prefix
	const withoutPrefix = trashId.slice(7); // "cloned-".length = 7
	if (!withoutPrefix) return null;

	// Split by "-"
	const parts = withoutPrefix.split("-");
	
	// Need at least: instanceId (1+ parts) + profileId (1 part) + uuid (2 or 5 parts) = 4 or 7 parts minimum
	if (parts.length < 4) return null;

	// Try to detect UUID format by testing the last segments
	// First, try standard 5-part UUID format
	const uuidParts5 = parts.slice(-5);
	const uuidCandidate5 = uuidParts5.join("-");
	// UUID regex: 8-4-4-4-12 hex digits
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	
	let profileIdIndex: number;
	let idSegmentLength: number;
	
	if (uuidRegex.test(uuidCandidate5) && parts.length >= 7) {
		// Standard 5-part UUID format detected
		idSegmentLength = 5;
		profileIdIndex = parts.length - 6; // profileId is second-to-last before UUID
	} else {
		// Try fallback 2-part format (timestamp-random)
		const uuidParts2 = parts.slice(-2);
		if (parts.length < 4) return null; // Need at least instanceId + profileId + 2-part ID
		
		// Check if first part is numeric (timestamp) and second is alphanumeric
		const timestampPart = uuidParts2[0];
		const randomPart = uuidParts2[1];
		
		if (timestampPart && randomPart && /^\d+$/.test(timestampPart) && /^[a-z0-9]+$/i.test(randomPart)) {
			// Fallback 2-part format detected
			idSegmentLength = 2;
			profileIdIndex = parts.length - 3; // profileId is third-to-last before 2-part ID
		} else {
			// Neither format matches
			return null;
		}
	}

	// Extract profileId and instanceId based on detected format
	const profileIdStr = parts[profileIdIndex];
	const instanceIdParts = parts.slice(0, profileIdIndex);
	const instanceId = instanceIdParts.join("-");

	// Validate that profileId and instanceId are non-empty
	if (!instanceId || !profileIdStr) return null;

	// Parse profileId as number
	const profileId = parseInt(profileIdStr, 10);
	if (isNaN(profileId) || profileId < 0) return null;

	return { instanceId, profileId };
}

interface QualityProfileWizardProps {
	open: boolean;
	onClose: () => void;
	serviceType: "RADARR" | "SONARR";
	editingTemplate?: TrashTemplate;
}

type WizardStep = "profile" | "quality" | "customize" | "cf-resolution" | "summary";

/**
 * Wizard-specific profile type that allows undefined trashId for edit mode.
 * In edit mode, we don't have the original TRaSH profile trashId since templates
 * don't persist that information. The trashId is only needed for new imports.
 */
type WizardSelectedProfile = Omit<QualityProfileSummary, 'trashId'> & {
	trashId?: string;
};

interface WizardState {
	currentStep: WizardStep;
	selectedProfile: WizardSelectedProfile | null;
	customFormatSelections: Record<string, {
		selected: boolean;
		scoreOverride?: number;
		conditionsEnabled: Record<string, boolean>;
	}>;
	templateName: string;
	templateDescription: string;
	templateId?: string; // For editing existing templates
	/** CF resolutions for cloned profiles (linking to TRaSH vs keeping instance) */
	cfResolutions?: ResolvedCF[];
	/** Custom quality configuration for power users */
	customQualityConfig?: CustomQualityConfig;
}

// Standard step order for TRaSH Guides profiles: quality config before CF config
const STANDARD_STEP_ORDER: WizardStep[] = ["profile", "quality", "customize", "summary"];
// Step order for cloned profiles: resolution BEFORE quality and configuration
const CLONED_STEP_ORDER: WizardStep[] = ["profile", "cf-resolution", "quality", "customize", "summary"];

const getStepTitles = (isEditMode: boolean, isClonedProfile: boolean): Record<WizardStep, string> => ({
	profile: "Select Quality Profile",
	quality: "Configure Qualities",
	customize: isEditMode ? "Edit Custom Formats" : "Configure Custom Formats",
	"cf-resolution": "Link Custom Formats",
	summary: isEditMode ? "Review & Update" : "Review & Create",
});

const getStepDescriptions = (isEditMode: boolean, isClonedProfile: boolean): Record<WizardStep, string> => ({
	profile: "Select a TRaSH Guides quality profile to import",
	quality: "Configure quality priorities, groupings, and cutoff settings",
	customize: isEditMode
		? "Modify formats, groups, and scores"
		: isClonedProfile
			? "Review matched CFs and adjust scores before deployment"
			: "Select CF groups and individual formats, adjust scores",
	"cf-resolution": "Match your instance's Custom Formats to TRaSH Guides equivalents",
	summary: isEditMode ? "Review your changes and update template" : "Review your selections and create template",
});

export const QualityProfileWizard = ({
	open,
	onClose,
	serviceType,
	editingTemplate,
}: QualityProfileWizardProps) => {
	const [wizardState, setWizardState] = useState<WizardState>({
		currentStep: "profile",
		selectedProfile: null,
		customFormatSelections: {},
		templateName: "",
		templateDescription: "",
		cfResolutions: undefined,
	});

	const isEditMode = !!editingTemplate;

	// Determine if current profile is cloned
	const isClonedProfileSelected = useMemo(
		() => isClonedProfile(wizardState.selectedProfile?.trashId),
		[wizardState.selectedProfile?.trashId]
	);

	// Get parsed cloned profile info if applicable
	const clonedProfileInfo = useMemo(
		() => wizardState.selectedProfile?.trashId
			? parseClonedProfileId(wizardState.selectedProfile.trashId)
			: null,
		[wizardState.selectedProfile?.trashId]
	);

	// Dynamic step order based on profile type
	const stepOrder = useMemo(
		() => isClonedProfileSelected ? CLONED_STEP_ORDER : STANDARD_STEP_ORDER,
		[isClonedProfileSelected]
	);

	const currentStepIndex = stepOrder.indexOf(wizardState.currentStep);
	const totalSteps = stepOrder.length;

	// Initialize wizard state from editing template
	useEffect(() => {
		if (editingTemplate && open) {
			// Convert template's config data into wizard format
			const selections: Record<string, {
				selected: boolean;
				scoreOverride?: number;
				conditionsEnabled: Record<string, boolean>;
			}> = {};

			// Map customFormats from template to wizard selections
			editingTemplate.config.customFormats.forEach((cf) => {
				selections[cf.trashId] = {
					selected: true,
					scoreOverride: cf.scoreOverride,
					conditionsEnabled: cf.conditionsEnabled || {},
				};
			});

			setWizardState({
				currentStep: "quality", // Start at quality configuration in edit mode
				selectedProfile: {
					// Note: trashId is intentionally undefined in edit mode.
					// Templates don't persist the original TRaSH profile ID.
					// The trashId is only needed for new imports from TRaSH Guides.
					trashId: undefined,
					name: editingTemplate.name,
					description: editingTemplate.description || "",
					// Provide default values for required QualityProfileSummary fields
					upgradeAllowed: true,
					cutoff: "",
					customFormatCount: editingTemplate.config.customFormats?.length || 0,
					qualityCount: 0,
				},
				customFormatSelections: selections,
				templateName: editingTemplate.name,
				templateDescription: editingTemplate.description || "",
				templateId: editingTemplate.id,
				// Initialize quality config: use effective config from template
				// (considers both customQualityConfig and qualityProfile)
				customQualityConfig: getEffectiveQualityConfig(editingTemplate.config),
			});
		} else if (!editingTemplate && open) {
			// Reset to initial state for new template
			setWizardState({
				currentStep: "profile",
				selectedProfile: null,
				customFormatSelections: {},
				templateName: "",
				templateDescription: "",
				templateId: undefined,
				cfResolutions: undefined,
				customQualityConfig: undefined,
			});
		}
	}, [editingTemplate, open]);

	const handleProfileSelected = (profile: QualityProfileSummary) => {
		// For cloned profiles, go to cf-resolution first; for TRaSH profiles, go to quality config
		const nextStep: WizardStep = isClonedProfile(profile.trashId) ? "cf-resolution" : "quality";
		setWizardState(prev => ({
			...prev,
			currentStep: nextStep,
			selectedProfile: profile,
			customFormatSelections: {},
			templateName: profile.name,
			templateDescription: profile.description
				? htmlToPlainText(profile.description)
				: `Imported from TRaSH Guides: ${profile.name}`,
		}));
	};

	const handleQualityConfigComplete = (qualityConfig: CustomQualityConfig) => {
		// After quality configuration, go to CF customization
		setWizardState(prev => ({
			...prev,
			currentStep: "customize",
			customQualityConfig: qualityConfig,
		}));
	};

	const handleCustomizationComplete = (
		selections: Record<string, {
			selected: boolean;
			scoreOverride?: number;
			conditionsEnabled: Record<string, boolean>;
		}>
	) => {
		// Go to summary - template naming happens in the Review step
		setWizardState(prev => ({
			...prev,
			currentStep: "summary",
			customFormatSelections: selections,
		}));
	};

	const handleCFResolutionComplete = (resolutions: ResolvedCF[]) => {
		// After CF resolution, go to quality step
		setWizardState(prev => ({
			...prev,
			currentStep: "quality",
			cfResolutions: resolutions,
		}));
	};

	const handleComplete = () => {
		// Reset wizard state
		setWizardState({
			currentStep: "profile",
			selectedProfile: null,
			customFormatSelections: {},
			templateName: "",
			templateDescription: "",
			cfResolutions: undefined,
			customQualityConfig: undefined,
		});
		onClose();
	};

	const handleBack = () => {
		const currentIndex = stepOrder.indexOf(wizardState.currentStep);
		if (currentIndex > 0) {
			const previousStep = stepOrder[currentIndex - 1];
			if (previousStep) {
				setWizardState(prev => ({
					...prev,
					currentStep: previousStep,
				}));
			}
		}
	};

	const handleEditStep = (step: WizardStep) => {
		setWizardState(prev => ({
			...prev,
			currentStep: step,
		}));
	};

	const handleClose = () => {
		// Reset on close
		setWizardState({
			currentStep: "profile",
			selectedProfile: null,
			customFormatSelections: {},
			templateName: "",
			templateDescription: "",
			cfResolutions: undefined,
			customQualityConfig: undefined,
		});
		onClose();
	};

	// Keyboard navigation
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") {
			handleClose();
		}
	};

	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
			onKeyDown={handleKeyDown}
			role="dialog"
			aria-modal="true"
			aria-labelledby="wizard-title"
		>
			<div className="relative w-full max-w-6xl max-h-[90vh] overflow-hidden rounded-xl border border-border/50 bg-bg-subtle shadow-xl">
				{/* Header with Progress Indicator */}
				<div className="sticky top-0 z-10 border-b border-border/50 bg-bg-subtle/95 backdrop-blur">
					<div className="p-6">
						<div className="flex items-center justify-between mb-4">
							<div>
								<h2 id="wizard-title" className="text-xl font-semibold text-fg">
									{getStepTitles(isEditMode, isClonedProfileSelected)[wizardState.currentStep]}
								</h2>
								<p className="mt-1 text-sm text-fg-muted">
									{getStepDescriptions(isEditMode, isClonedProfileSelected)[wizardState.currentStep]}
								</p>
							</div>
							<Button
								variant="ghost"
								size="sm"
								onClick={handleClose}
								aria-label="Close wizard"
							>
								<X className="h-5 w-5" />
							</Button>
						</div>

						{/* Progress Indicator */}
						<div className="flex items-center gap-2">
							{stepOrder.map((step, index) => {
								const isActive = index === currentStepIndex;
								const isCompleted = index < currentStepIndex;
								const isAccessible = index <= currentStepIndex;
								// In edit mode, allow navigating to any step except profile (step 0)
								const canNavigate = isEditMode
									? index > 0 && !isActive
									: isCompleted && !isActive;

								return (
									<div key={step} className="flex items-center flex-1">
										<button
											type="button"
											onClick={() => canNavigate && handleEditStep(step)}
											disabled={!canNavigate}
											className={`flex items-center gap-2 flex-1 ${
												canNavigate ? "cursor-pointer group" : "cursor-default"
											}`}
										>
											<div
												className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition ${
													isActive
														? "bg-primary text-primary-fg ring-2 ring-primary/30"
														: isCompleted
															? "bg-primary/20 text-primary"
															: "bg-bg-hover text-fg-muted"
												} ${canNavigate ? "group-hover:ring-2 group-hover:ring-primary/50" : ""}`}
											>
												{index + 1}
											</div>
											<div className="hidden sm:block flex-1 min-w-0">
												<div
													className={`text-xs font-medium truncate transition text-left ${
														isAccessible ? "text-fg" : "text-fg-muted"
													} ${canNavigate ? "group-hover:text-primary" : ""}`}
												>
													{getStepTitles(isEditMode, isClonedProfileSelected)[step]}
												</div>
											</div>
										</button>
										{index < stepOrder.length - 1 && (
											<div
												className={`h-0.5 w-full mx-2 transition ${
													isCompleted ? "bg-primary" : "bg-bg-hover"
												}`}
											/>
										)}
									</div>
								);
							})}
						</div>
					</div>
				</div>

				{/* Content */}
				<div className="overflow-y-auto p-6" style={{ maxHeight: "calc(90vh - 180px)" }}>
					{wizardState.currentStep === "profile" && !isEditMode && (
						<QualityProfileSelection
							serviceType={serviceType}
							onSelect={handleProfileSelected}
						/>
					)}

					{wizardState.currentStep === "quality" && wizardState.selectedProfile && (
						<QualityConfiguration
							serviceType={serviceType}
							qualityProfile={wizardState.selectedProfile}
							initialQualityConfig={wizardState.customQualityConfig}
							onNext={handleQualityConfigComplete}
							onBack={isEditMode ? undefined : handleBack}
							isEditMode={isEditMode}
						/>
					)}

					{wizardState.currentStep === "customize" && wizardState.selectedProfile && (
						<CFConfiguration
							serviceType={serviceType}
							qualityProfile={wizardState.selectedProfile}
							initialSelections={wizardState.customFormatSelections}
							onNext={handleCustomizationComplete}
							onBack={isEditMode ? undefined : handleBack} // Disable back in edit mode
							isEditMode={isEditMode} // Pass edit mode flag
							editingTemplate={editingTemplate} // Pass template data for edit mode
							cfResolutions={wizardState.cfResolutions} // Pass CF resolutions from previous step
						/>
					)}

					{wizardState.currentStep === "cf-resolution" && wizardState.selectedProfile && clonedProfileInfo && (
						<CFResolution
							serviceType={serviceType}
							instanceId={clonedProfileInfo.instanceId}
							profileId={clonedProfileInfo.profileId}
							profileName={wizardState.selectedProfile.name}
							onComplete={handleCFResolutionComplete}
							onBack={handleBack}
							initialResolutions={wizardState.cfResolutions}
						/>
					)}

					{wizardState.currentStep === "summary" && wizardState.selectedProfile && (
						<TemplateCreation
							serviceType={serviceType}
							wizardState={{
								selectedProfile: wizardState.selectedProfile,
								customFormatSelections: wizardState.customFormatSelections,
								templateName: wizardState.templateName,
								templateDescription: wizardState.templateDescription,
								customQualityConfig: wizardState.customQualityConfig,
							}}
							templateId={wizardState.templateId} // Pass template ID for update
							isEditMode={isEditMode}
							editingTemplate={editingTemplate} // Pass template for CF group info in edit mode
							onComplete={handleComplete}
							onBack={handleBack}
							onEditStep={handleEditStep}
						/>
					)}
				</div>
			</div>
		</div>
	);
};
