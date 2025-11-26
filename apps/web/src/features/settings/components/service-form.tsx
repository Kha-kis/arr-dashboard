"use client";

import type { ReactNode } from "react";
import type { ServiceInstanceSummary } from "@arr/shared";
import type { ServiceFormState } from "../lib/settings-utils";
import {
	Button,
	Input,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	CardDescription,
	Alert,
	AlertDescription,
	FormField,
} from "../../../components/ui";
import { cn } from "../../../lib/utils";
import { SERVICE_TYPES, SELECT_CLASS, OPTION_STYLE } from "../lib/settings-constants";
import { getServicePlaceholders } from "../lib/settings-utils";

/**
 * Props for the ServiceForm component
 */
interface ServiceFormProps {
	/** Current form state */
	formState: ServiceFormState;
	/** Handler for form state changes */
	onFormStateChange: (updater: (prev: ServiceFormState) => ServiceFormState) => void;
	/** Handler for form submission */
	onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
	/** Handler for cancel button */
	onCancel: () => void;
	/** Handler for test connection button */
	onTestConnection: () => void;
	/** The service being edited (null if adding new) */
	selectedService: ServiceInstanceSummary | null;
	/** Available tags for autocomplete */
	availableTags: string[];
	/** Whether creation is pending */
	isCreating: boolean;
	/** Whether update is pending */
	isUpdating: boolean;
	/** Whether connection test is pending */
	isTesting: boolean;
	/** Connection test result */
	testResult?: {
		success: boolean;
		message: string;
	} | null;
	/** Content for the default settings section */
	defaultSectionContent: ReactNode;
}

/**
 * Form for adding or editing service instances
 */
export const ServiceForm = ({
	formState,
	onFormStateChange,
	onSubmit,
	onCancel,
	onTestConnection,
	selectedService,
	availableTags,
	isCreating,
	isUpdating,
	isTesting,
	testResult,
	defaultSectionContent,
}: ServiceFormProps) => {
	const placeholders = getServicePlaceholders(formState.service);

	return (
		<Card>
			<CardHeader>
				<CardTitle>{selectedService ? "Edit Service" : "Add Service"}</CardTitle>
				<CardDescription>
					{selectedService
						? "Update connection details. Leave API key empty to keep the current key."
						: "Provide the base URL and API key for the instance."}
				</CardDescription>
			</CardHeader>
			<CardContent>
				<form className="space-y-4" onSubmit={onSubmit}>
					<div className="space-y-2">
						<label className="text-xs uppercase text-white/60">Service</label>
						<div className="flex gap-2">
							{SERVICE_TYPES.map((service) => (
								<button
									key={service}
									type="button"
									onClick={() =>
										onFormStateChange((prev) => ({
											...prev,
											service,
											defaultQualityProfileId: "",
											defaultLanguageProfileId: "",
											defaultRootFolderPath: "",
											defaultSeasonFolder: "",
											isDefault: service === "prowlarr" ? false : prev.isDefault,
										}))
									}
									className={cn(
										"flex-1 rounded-lg border px-3 py-2 text-sm capitalize transition",
										formState.service === service
											? "border-sky-400 bg-sky-500/20 text-white"
											: "border-white/10 bg-white/5 text-white/60 hover:text-white",
									)}
								>
									{service}
								</button>
							))}
						</div>
					</div>
					<FormField
						label="Label"
						htmlFor="service-label"
						hint={`Friendly name for this ${formState.service} instance`}
						required
					>
						<Input
							id="service-label"
							value={formState.label}
							onChange={(event) =>
								onFormStateChange((prev) => ({
									...prev,
									label: event.target.value,
								}))
							}
							placeholder={placeholders.label}
							required
						/>
					</FormField>
					<FormField
						label="Base URL"
						htmlFor="service-baseurl"
						hint="Full URL including http:// or https://"
						required
					>
						<Input
							id="service-baseurl"
							type="url"
							value={formState.baseUrl}
							onChange={(event) =>
								onFormStateChange((prev) => ({
									...prev,
									baseUrl: event.target.value,
								}))
							}
							placeholder={placeholders.baseUrl}
							required
						/>
					</FormField>
					<FormField
						label="API Key"
						htmlFor="service-apikey"
						hint={selectedService ? "Leave empty to keep current key" : "Found in Settings > General"}
						required={!selectedService}
					>
						<Input
							id="service-apikey"
							type="password"
							value={formState.apiKey}
							onChange={(event) =>
								onFormStateChange((prev) => ({
									...prev,
									apiKey: event.target.value,
								}))
							}
							placeholder={selectedService ? "Leave blank to keep current key" : "Your API key"}
							required={!selectedService}
						/>
					</FormField>
					<div className="space-y-2">
						<Button
							type="button"
							variant="secondary"
							onClick={onTestConnection}
							disabled={isTesting || !formState.baseUrl || !formState.apiKey}
						>
							{isTesting ? "Testing connection..." : "Test connection"}
						</Button>
						{testResult && (
							<Alert variant={testResult.success ? "success" : "danger"}>
								<AlertDescription>{testResult.message}</AlertDescription>
							</Alert>
						)}
					</div>
					<div className="space-y-2">
						<label className="text-xs uppercase text-white/60">Tags</label>
						<Input
							value={formState.tags}
							onChange={(event) =>
								onFormStateChange((prev) => ({
									...prev,
									tags: event.target.value,
								}))
							}
							placeholder="Comma separated"
							list="available-tags"
						/>
						<datalist id="available-tags">
							{availableTags.map((tag) => (
								<option key={tag} value={tag} />
							))}
						</datalist>
					</div>
					{formState.service !== "prowlarr" && (
						<div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
							<div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
								<p className="text-xs uppercase tracking-widest text-white/40">
									Default add settings
								</p>
								<span className="text-xs text-white/50">
									Applied when using Discover and library tools.
								</span>
							</div>
							{defaultSectionContent}
						</div>
					)}
					<div className="flex items-center gap-3">
						<label className="flex items-center gap-2 text-sm text-white/70">
							<input
								type="checkbox"
								className="h-4 w-4 border border-white/20 bg-white/10"
								checked={formState.enabled}
								onChange={(event) =>
									onFormStateChange((prev) => ({
										...prev,
										enabled: event.target.checked,
									}))
								}
							/>
							Enabled
						</label>
						{formState.service !== "prowlarr" && (
							<label className="flex items-center gap-2 text-sm text-white/70">
								<input
									type="checkbox"
									className="h-4 w-4 border border-white/20 bg-white/10"
									checked={formState.isDefault}
									onChange={(event) =>
										onFormStateChange((prev) => ({
											...prev,
											isDefault: event.target.checked,
										}))
									}
								/>
								Default
							</label>
						)}
					</div>
					<div className="flex gap-2">
						<Button type="submit" disabled={isCreating || isUpdating}>
							{selectedService ? "Save changes" : "Add service"}
						</Button>
						{selectedService && (
							<Button type="button" variant="ghost" onClick={onCancel} disabled={isUpdating}>
								Cancel
							</Button>
						)}
					</div>
				</form>
			</CardContent>
		</Card>
	);
};
