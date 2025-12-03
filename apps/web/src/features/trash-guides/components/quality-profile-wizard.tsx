"use client";

import { useState, useEffect, useMemo } from "react";
import { Button } from "../../../components/ui";
import { X } from "lucide-react";
import type { QualityProfileSummary } from "../../../lib/api-client/trash-guides";
import type { TrashTemplate } from "@arr/shared";
import { QualityProfileSelection } from "./wizard-steps/quality-profile-selection";
import { CFConfiguration } from "./wizard-steps/cf-configuration";
import { CFResolution, type ResolvedCF } from "./wizard-steps/cf-resolution";
import { TemplateCreation } from "./wizard-steps/template-creation";
import { htmlToPlainText } from "../lib/description-utils";

/**
 * Check if a trashId indicates a cloned profile from an instance
 * Cloned profile trashIds have format: cloned-{instanceId}-{profileId}-{uuid}
 */
function isClonedProfile(trashId: string | undefined): boolean {
	return !!trashId && trashId.startsWith("cloned-");
}

/**
 * Parse cloned profile trashId to extract instanceId and profileId
 */
function parseClonedProfileId(trashId: string): { instanceId: string; profileId: number } | null {
	if (!isClonedProfile(trashId)) return null;

	// Format: cloned-{instanceId}-{profileId}-{uuid}
	const parts = trashId.split("-");
	if (parts.length < 4) return null;

	const instanceId = parts[1];
	const profileId = parseInt(parts[2] || "", 10);

	if (!instanceId || isNaN(profileId)) return null;

	return { instanceId, profileId };
}

interface QualityProfileWizardProps {
	open: boolean;
	onClose: () => void;
	serviceType: "RADARR" | "SONARR";
	editingTemplate?: TrashTemplate;
}

type WizardStep = "profile" | "customize" | "cf-resolution" | "summary";

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
}

// Standard step order for TRaSH Guides profiles
const STANDARD_STEP_ORDER: WizardStep[] = ["profile", "customize", "summary"];
// Step order for cloned profiles: resolution BEFORE configuration so users can see matches first
const CLONED_STEP_ORDER: WizardStep[] = ["profile", "cf-resolution", "customize", "summary"];

const getStepTitles = (isEditMode: boolean, isClonedProfile: boolean): Record<WizardStep, string> => ({
	profile: "Select Quality Profile",
	customize: isEditMode ? "Edit Custom Formats" : "Configure Custom Formats",
	"cf-resolution": "Link Custom Formats",
	summary: isEditMode ? "Review & Update" : "Review & Create",
});

const getStepDescriptions = (isEditMode: boolean, isClonedProfile: boolean): Record<WizardStep, string> => ({
	profile: "Select a TRaSH Guides quality profile to import",
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
				currentStep: "customize", // Skip profile selection in edit mode
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
			});
		}
	}, [editingTemplate, open]);

	const handleProfileSelected = (profile: QualityProfileSummary) => {
		// For cloned profiles, go to cf-resolution first; for TRaSH profiles, go to customize
		const nextStep: WizardStep = isClonedProfile(profile.trashId) ? "cf-resolution" : "customize";
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

	const handleCustomizationComplete = (
		selections: Record<string, {
			selected: boolean;
			scoreOverride?: number;
			conditionsEnabled: Record<string, boolean>;
		}>,
		name: string,
		description: string
	) => {
		// Always go to summary - CF resolution (if needed) already happened before customize
		setWizardState(prev => ({
			...prev,
			currentStep: "summary",
			customFormatSelections: selections,
			templateName: name,
			templateDescription: description,
		}));
	};

	const handleCFResolutionComplete = (resolutions: ResolvedCF[]) => {
		// After CF resolution, go to customize step so users can adjust scores
		setWizardState(prev => ({
			...prev,
			currentStep: "customize",
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

	const handleEditStep = (step: "profile" | "customize") => {
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

								return (
									<div key={step} className="flex items-center flex-1">
										<div className="flex items-center gap-2 flex-1">
											<div
												className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium transition ${
													isActive
														? "bg-primary text-white ring-2 ring-primary/30"
														: isCompleted
															? "bg-primary/20 text-primary"
															: "bg-bg-hover text-fg-muted"
												}`}
											>
												{index + 1}
											</div>
											<div className="hidden sm:block flex-1 min-w-0">
												<div
													className={`text-xs font-medium truncate transition ${
														isAccessible ? "text-fg" : "text-fg-muted"
													}`}
												>
													{getStepTitles(isEditMode, isClonedProfileSelected)[step]}
												</div>
											</div>
										</div>
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


					{wizardState.currentStep === "customize" && wizardState.selectedProfile && (
						<CFConfiguration
							serviceType={serviceType}
							qualityProfile={wizardState.selectedProfile}
							initialSelections={wizardState.customFormatSelections}
							templateName={wizardState.templateName}
							templateDescription={wizardState.templateDescription}
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
							}}
							templateId={wizardState.templateId} // Pass template ID for update
							isEditMode={isEditMode}
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
