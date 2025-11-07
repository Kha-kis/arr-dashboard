"use client";

import { useState } from "react";
import { X } from "lucide-react";
import type { QualityProfileSummary } from "../../../lib/api-client/trash-guides";
import { QualityProfileSelection } from "./wizard-steps/quality-profile-selection";
import { CFGroupSelection } from "./wizard-steps/cf-group-selection";
import { CFConfiguration } from "./wizard-steps/cf-configuration";
import { TemplateCreation } from "./wizard-steps/template-creation";

interface QualityProfileWizardProps {
	open: boolean;
	onClose: () => void;
	serviceType: "RADARR" | "SONARR";
}

type WizardStep = "profile" | "groups" | "customize" | "summary";

interface WizardState {
	currentStep: WizardStep;
	selectedProfile: QualityProfileSummary | null;
	selectedGroups: Set<string>;
	customFormatSelections: Record<string, {
		selected: boolean;
		scoreOverride?: number;
		conditionsEnabled: Record<string, boolean>;
	}>;
	templateName: string;
	templateDescription: string;
}

const STEP_ORDER: WizardStep[] = ["profile", "groups", "customize", "summary"];

const STEP_TITLES: Record<WizardStep, string> = {
	profile: "Select Quality Profile",
	groups: "Choose CF Groups",
	customize: "Customize Formats",
	summary: "Review & Create",
};

const STEP_DESCRIPTIONS: Record<WizardStep, string> = {
	profile: "Select a TRaSH Guides quality profile to import",
	groups: "Select optional CF groups (quick setup)",
	customize: "Fine-tune individual custom formats",
	summary: "Review your selections and create template",
};

export const QualityProfileWizard = ({
	open,
	onClose,
	serviceType,
}: QualityProfileWizardProps) => {
	const [wizardState, setWizardState] = useState<WizardState>({
		currentStep: "profile",
		selectedProfile: null,
		selectedGroups: new Set(),
		customFormatSelections: {},
		templateName: "",
		templateDescription: "",
	});

	const currentStepIndex = STEP_ORDER.indexOf(wizardState.currentStep);
	const totalSteps = STEP_ORDER.length;

	const handleProfileSelected = (profile: QualityProfileSummary) => {
		setWizardState(prev => ({
			...prev,
			currentStep: "groups",
			selectedProfile: profile,
			customFormatSelections: {},
			templateName: profile.name,
			templateDescription: profile.description
				? profile.description.replace(/<br>/g, "\n")
				: `Imported from TRaSH Guides: ${profile.name}`,
		}));
	};

	const handleGroupsSelected = (groups: Set<string>) => {
		setWizardState(prev => ({
			...prev,
			currentStep: "customize",
			selectedGroups: groups,
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
			currentStep: "summary",
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
			selectedGroups: new Set(),
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
			setWizardState(prev => ({
				...prev,
				currentStep: previousStep,
			}));
		}
	};

	const handleSkipToCustomization = () => {
		setWizardState(prev => ({
			...prev,
			currentStep: "customize",
		}));
	};

	const handleClose = () => {
		// Reset on close
		setWizardState({
			currentStep: "profile",
			selectedProfile: null,
			selectedGroups: new Set(),
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
									{STEP_TITLES[wizardState.currentStep]}
								</h2>
								<p className="mt-1 text-sm text-fg-muted">
									{STEP_DESCRIPTIONS[wizardState.currentStep]}
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
													{STEP_TITLES[step]}
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
					{wizardState.currentStep === "profile" && (
						<QualityProfileSelection
							serviceType={serviceType}
							onSelect={handleProfileSelected}
						/>
					)}

					{wizardState.currentStep === "groups" && wizardState.selectedProfile && (
						<CFGroupSelection
							serviceType={serviceType}
							qualityProfile={wizardState.selectedProfile}
							initialSelection={wizardState.selectedGroups}
							onNext={handleGroupsSelected}
							onBack={handleBack}
							onSkip={handleSkipToCustomization}
						/>
					)}

					{wizardState.currentStep === "customize" && wizardState.selectedProfile && (
						<CFConfiguration
							serviceType={serviceType}
							qualityProfile={wizardState.selectedProfile}
							selectedGroups={wizardState.selectedGroups}
							initialSelections={wizardState.customFormatSelections}
							templateName={wizardState.templateName}
							templateDescription={wizardState.templateDescription}
							onNext={handleCustomizationComplete}
							onBack={handleBack}
						/>
					)}

					{wizardState.currentStep === "summary" && wizardState.selectedProfile && (
						<TemplateCreation
							serviceType={serviceType}
							wizardState={{
								selectedProfile: wizardState.selectedProfile,
								selectedGroups: wizardState.selectedGroups,
								customFormatSelections: wizardState.customFormatSelections,
								templateName: wizardState.templateName,
								templateDescription: wizardState.templateDescription,
							}}
							onComplete={handleComplete}
							onBack={handleBack}
						/>
					)}
				</div>
			</div>
		</div>
	);
};
