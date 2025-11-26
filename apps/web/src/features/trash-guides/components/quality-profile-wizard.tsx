"use client";

import { useState, useEffect } from "react";
import { X } from "lucide-react";
import type { QualityProfileSummary } from "../../../lib/api-client/trash-guides";
import type { TrashTemplate } from "@arr/shared";
import { QualityProfileSelection } from "./wizard-steps/quality-profile-selection";
import { CFConfiguration } from "./wizard-steps/cf-configuration";
import { TemplateCreation } from "./wizard-steps/template-creation";
import { htmlToPlainText } from "../lib/description-utils";

interface QualityProfileWizardProps {
	open: boolean;
	onClose: () => void;
	serviceType: "RADARR" | "SONARR";
	editingTemplate?: TrashTemplate;
}

type WizardStep = "profile" | "customize" | "summary";

interface WizardState {
	currentStep: WizardStep;
	selectedProfile: QualityProfileSummary | null;
	customFormatSelections: Record<string, {
		selected: boolean;
		scoreOverride?: number;
		conditionsEnabled: Record<string, boolean>;
	}>;
	templateName: string;
	templateDescription: string;
	templateId?: string; // For editing existing templates
}

const STEP_ORDER: WizardStep[] = ["profile", "customize", "summary"];

const getStepTitles = (isEditMode: boolean): Record<WizardStep, string> => ({
	profile: "Select Quality Profile",
	customize: isEditMode ? "Edit Custom Formats" : "Configure Custom Formats",
	summary: isEditMode ? "Review & Update" : "Review & Create",
});

const getStepDescriptions = (isEditMode: boolean): Record<WizardStep, string> => ({
	profile: "Select a TRaSH Guides quality profile to import",
	customize: isEditMode ? "Modify formats, groups, and scores" : "Select CF groups and individual formats, adjust scores",
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
	});

	const currentStepIndex = STEP_ORDER.indexOf(wizardState.currentStep);
	const totalSteps = STEP_ORDER.length;
	const isEditMode = !!editingTemplate;

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
					trashId: editingTemplate.id, // Use template ID as placeholder
					name: editingTemplate.name,
					description: editingTemplate.description || "",
				} as QualityProfileSummary,
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
			});
		}
	}, [editingTemplate, open]);

	const handleProfileSelected = (profile: QualityProfileSummary) => {
		setWizardState(prev => ({
			...prev,
			currentStep: "customize",
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
		setWizardState(prev => ({
			...prev,
			currentStep: "summary" as WizardStep,
			customFormatSelections: selections,
			templateName: name,
			templateDescription: description,
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
		});
		onClose();
	};

	const handleBack = () => {
		const currentIndex = STEP_ORDER.indexOf(wizardState.currentStep);
		if (currentIndex > 0) {
			const previousStep = STEP_ORDER[currentIndex - 1];
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
									{getStepTitles(isEditMode)[wizardState.currentStep]}
								</h2>
								<p className="mt-1 text-sm text-fg-muted">
									{getStepDescriptions(isEditMode)[wizardState.currentStep]}
								</p>
							</div>
							<button
								type="button"
								onClick={handleClose}
								className="rounded p-1 text-fg-muted hover:bg-bg-hover hover:text-fg transition"
								aria-label="Close wizard"
							>
								<X className="h-5 w-5" />
							</button>
						</div>

						{/* Progress Indicator */}
						<div className="flex items-center gap-2">
							{STEP_ORDER.map((step, index) => {
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
													{getStepTitles(isEditMode)[step]}
												</div>
											</div>
										</div>
										{index < STEP_ORDER.length - 1 && (
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
