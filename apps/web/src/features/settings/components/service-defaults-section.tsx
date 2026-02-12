"use client";

import type { ReactNode } from "react";
import type { ServiceInstanceSummary } from "@arr/shared";
import type { ServiceFormState } from "../lib/settings-utils";
import { SELECT_CLASS, OPTION_STYLE } from "../lib/settings-constants";

/**
 * Props for ServiceDefaultsSection
 */
interface ServiceDefaultsSectionProps {
	/** The service instance being edited (null when creating new) */
	selectedService: ServiceInstanceSummary | null;
	/** Current form state */
	formState: ServiceFormState;
	/** Handler for form state changes */
	onFormStateChange: (updater: (prev: ServiceFormState) => ServiceFormState) => void;
	/** Whether options are loading */
	optionsPending: boolean;
	/** Whether options failed to load */
	optionsLoadFailed: boolean;
	/** Instance options data (from test endpoint or instance endpoint) */
	optionsData: {
		qualityProfiles: Array<{ id: number; name: string }>;
		rootFolders: Array<{ path: string; id?: number | string; accessible?: boolean; freeSpace?: number }>;
		languageProfiles?: Array<{ id: number; name: string }>;
	} | null;
}

/**
 * Displays the default settings section for a service form
 */
export const ServiceDefaultsSection = ({
	selectedService: _selectedService,
	formState,
	onFormStateChange,
	optionsPending,
	optionsLoadFailed,
	optionsData,
}: ServiceDefaultsSectionProps): ReactNode => {
	// Show loading state
	if (optionsPending) {
		return <p className="text-sm text-muted-foreground">Fetching available quality profiles...</p>;
	}

	// Show error state
	if (optionsLoadFailed) {
		return (
			<p className="text-sm text-amber-300">
				Unable to load instance options. Verify the connection details and API key.
			</p>
		);
	}

	if (!optionsData) {
		return null;
	}

	const hasQualityProfiles = optionsData.qualityProfiles.length > 0;
	const hasRootFolders = optionsData.rootFolders.length > 0;
	const hasLanguageProfiles =
		Array.isArray(optionsData.languageProfiles) && optionsData.languageProfiles.length > 0;

	return (
		<>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="space-y-2">
					<label className="text-xs uppercase text-muted-foreground">Quality profile</label>
					<select
						className={SELECT_CLASS}
						value={formState.defaultQualityProfileId}
						onChange={(event) =>
							onFormStateChange((prev) => ({
								...prev,
								defaultQualityProfileId: event.target.value,
							}))
						}
						disabled={!hasQualityProfiles}
					>
						<option value="" style={OPTION_STYLE}>
							Use instance default
						</option>
						{optionsData.qualityProfiles.map((profile) => (
							<option key={profile.id} value={profile.id} style={OPTION_STYLE}>
								{profile.name}
							</option>
						))}
					</select>
					{!hasQualityProfiles && (
						<p className="text-xs text-amber-300">No quality profiles available.</p>
					)}
				</div>
				<div className="space-y-2">
					<label className="text-xs uppercase text-muted-foreground">Root folder</label>
					<select
						className={SELECT_CLASS}
						value={formState.defaultRootFolderPath}
						onChange={(event) =>
							onFormStateChange((prev) => ({
								...prev,
								defaultRootFolderPath: event.target.value,
							}))
						}
						disabled={!hasRootFolders}
					>
						<option value="" style={OPTION_STYLE}>
							Use instance default
						</option>
						{optionsData.rootFolders.map((folder) => (
							<option key={folder.path} value={folder.path} style={OPTION_STYLE}>
								{folder.path}
							</option>
						))}
					</select>
					{!hasRootFolders && <p className="text-xs text-amber-300">No root folders configured.</p>}
				</div>
			</div>
			{formState.service === "sonarr" && (
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="space-y-2">
						<label className="text-xs uppercase text-muted-foreground">Language profile</label>
						<select
							className={SELECT_CLASS}
							value={formState.defaultLanguageProfileId}
							onChange={(event) =>
								onFormStateChange((prev) => ({
									...prev,
									defaultLanguageProfileId: event.target.value,
								}))
							}
							disabled={!hasLanguageProfiles}
						>
							<option value="" style={OPTION_STYLE}>
								Use instance default
							</option>
							{optionsData.languageProfiles?.map((profile) => (
								<option key={profile.id} value={profile.id} style={OPTION_STYLE}>
									{profile.name}
								</option>
							))}
						</select>
						{!hasLanguageProfiles && (
							<p className="text-xs text-amber-300">No language profiles available.</p>
						)}
					</div>
					<div className="space-y-2">
						<label className="text-xs uppercase text-muted-foreground">Season folders</label>
						<select
							className={SELECT_CLASS}
							value={formState.defaultSeasonFolder}
							onChange={(event) =>
								onFormStateChange((prev) => ({
									...prev,
									defaultSeasonFolder: event.target
										.value as ServiceFormState["defaultSeasonFolder"],
								}))
							}
						>
							<option value="" style={OPTION_STYLE}>
								Use instance default
							</option>
							<option value="true" style={OPTION_STYLE}>
								Create season folders
							</option>
							<option value="false" style={OPTION_STYLE}>
								Keep all episodes together
							</option>
						</select>
					</div>
				</div>
			)}
		</>
	);
};
