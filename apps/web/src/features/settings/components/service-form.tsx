"use client";

import type { ServiceInstanceSummary } from "@arr/shared";
import {
	Alert,
	AlertDescription,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	Input,
	SimpleFormField,
} from "../../../components/ui";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { cn } from "../../../lib/utils";
import { getLinuxUrl, useIncognitoMode } from "../../../lib/incognito";
import { SERVICE_TYPES } from "../lib/settings-constants";
import type { ServiceFormState } from "../lib/settings-utils";
import { getServicePlaceholders } from "../lib/settings-utils";
import { PlexOAuthSection } from "./plex-oauth-section";
import { SeerrAutoSetupSection } from "./seerr-auto-setup-section";

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
	/** Existing configured services (for URL suggestions) */
	services: ServiceInstanceSummary[];
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
		version?: string;
		error?: string;
		details?: string;
	} | null;
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
	services,
	availableTags,
	isCreating,
	isUpdating,
	isTesting,
	testResult,
}: ServiceFormProps) => {
	const { gradient: themeGradient } = useThemeGradient();
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
				<form className="space-y-4" onSubmit={onSubmit} autoComplete="off">
					<div className="space-y-2">
						<label className="text-xs uppercase text-muted-foreground">Service</label>
						<div className="flex gap-2">
							{SERVICE_TYPES.map((service) => (
								<button
									key={service}
									type="button"
									onClick={() =>
										onFormStateChange((prev) => ({
											...prev,
											service,
											isDefault: service === "prowlarr" ? false : prev.isDefault,
										}))
									}
									className={cn(
										"flex-1 rounded-lg border px-3 py-2 text-sm capitalize transition-all duration-200",
										formState.service !== service &&
											"border-border bg-card text-muted-foreground hover:text-foreground",
									)}
									style={
										formState.service === service
											? {
													borderColor: themeGradient.from,
													backgroundColor: themeGradient.fromLight,
													color: themeGradient.from,
												}
											: undefined
									}
								>
									{service}
								</button>
							))}
						</div>
					</div>
					{formState.service === "plex" && (
						<PlexOAuthSection
							mode={selectedService ? "edit" : "add"}
							onServerSelected={(label, baseUrl, apiKey) =>
								onFormStateChange((prev) => ({
									...prev,
									label,
									baseUrl,
									apiKey,
								}))
							}
							onTestConnection={onTestConnection}
						/>
					)}
					<SimpleFormField
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
							autoComplete="off"
						/>
					</SimpleFormField>
					<SimpleFormField
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
							autoComplete="off"
							data-1p-ignore
							data-lpignore="true"
							data-form-type="other"
						/>
					</SimpleFormField>
					{!selectedService && !formState.baseUrl && (
						<UrlSuggestions
							currentService={formState.service}
							services={services}
							onSelect={(url) => onFormStateChange((prev) => ({ ...prev, baseUrl: url }))}
						/>
					)}
					{formState.service === "seerr" && (
						<SeerrAutoSetupSection
							seerrUrl={formState.baseUrl}
							mode={selectedService ? "edit" : "add"}
							onApiKeyFetched={(apiKey) =>
								onFormStateChange((prev) => ({
									...prev,
									apiKey,
								}))
							}
							onTestConnection={onTestConnection}
						/>
					)}
					<SimpleFormField
						label="External URL"
						htmlFor="service-externalurl"
						hint="Browser-accessible URL if using a reverse proxy (leave empty to use Base URL)"
					>
						<Input
							id="service-externalurl"
							type="url"
							value={formState.externalUrl}
							onChange={(event) =>
								onFormStateChange((prev) => ({
									...prev,
									externalUrl: event.target.value,
								}))
							}
							placeholder="https://sonarr.example.com"
							autoComplete="off"
							data-1p-ignore
							data-lpignore="true"
							data-form-type="other"
						/>
					</SimpleFormField>
					<SimpleFormField
						label="API Key"
						htmlFor="service-apikey"
						hint={
							selectedService ? "Leave empty to keep current key" : "Found in Settings > General"
						}
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
							autoComplete="off"
							data-1p-ignore
							data-lpignore="true"
							data-form-type="other"
						/>
					</SimpleFormField>
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
								<AlertDescription>
									<div className="space-y-1">
										<div className="flex items-center gap-2">
											<span>{testResult.message}</span>
											{testResult.version && (
												<span className="rounded bg-background/50 px-1.5 py-0.5 text-[10px] font-medium">
													v{testResult.version.replace(/^v/i, "")}
												</span>
											)}
										</div>
										{testResult.details && (
											<p className="line-clamp-3 text-xs opacity-80">{testResult.details}</p>
										)}
									</div>
								</AlertDescription>
							</Alert>
						)}
					</div>
					<div className="space-y-2">
						<label className="text-xs uppercase text-muted-foreground">Tags</label>
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
						<SimpleFormField
							label="Storage Group"
							htmlFor="service-storage-group"
							hint="Group instances sharing the same storage to avoid duplicate disk stats in statistics"
						>
							<Input
								id="service-storage-group"
								value={formState.storageGroupId}
								onChange={(event) =>
									onFormStateChange((prev) => ({
										...prev,
										storageGroupId: event.target.value,
									}))
								}
								placeholder="e.g., main-nas, media-server"
								autoComplete="off"
							/>
						</SimpleFormField>
					)}
					<div className="flex items-center gap-3">
						<label className="flex items-center gap-2 text-sm text-muted-foreground">
							<input
								type="checkbox"
								className="h-4 w-4 border border-border bg-card"
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
							<label className="flex items-center gap-2 text-sm text-muted-foreground">
								<input
									type="checkbox"
									className="h-4 w-4 border border-border bg-card"
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

/** Default ports for companion services, keyed by service type */
const COMPANION_PORTS: Record<string, number> = {
	seerr: 5055,
	tautulli: 8181,
	sonarr: 8989,
	radarr: 7878,
	prowlarr: 9696,
	lidarr: 8686,
	readarr: 8787,
};

/**
 * Suggests URLs for companion services based on existing configured service hosts.
 * When a Plex server is configured at 192.168.0.185:32400, suggests Seerr at :5055, etc.
 */
const UrlSuggestions = ({
	currentService,
	services,
	onSelect,
}: {
	currentService: string;
	services: ServiceInstanceSummary[];
	onSelect: (url: string) => void;
}) => {
	const [isIncognito] = useIncognitoMode();

	// Extract unique hosts with their protocol from existing services
	const knownHosts = new Map<string, string>();
	for (const svc of services) {
		try {
			const parsed = new URL(svc.baseUrl);
			if (!knownHosts.has(parsed.hostname)) {
				knownHosts.set(parsed.hostname, parsed.protocol);
			}
		} catch {
			// Malformed baseUrl in stored service — skip suggestion, not actionable here
		}
	}

	if (knownHosts.size === 0) return null;

	const defaultPort = COMPANION_PORTS[currentService];
	if (!defaultPort) return null;

	// Build suggestions: each known host + protocol + the current service's default port
	const suggestions = Array.from(knownHosts).map(
		([host, protocol]) => `${protocol}//${host}:${defaultPort}`,
	);

	// Filter out URLs that already match a configured service
	const configuredUrls = new Set(services.map((s) => s.baseUrl.replace(/\/$/, "")));
	const unique = suggestions.filter((url) => !configuredUrls.has(url));

	if (unique.length === 0) return null;

	return (
		<div className="flex flex-wrap gap-1.5">
			<span className="text-xs text-muted-foreground">Try:</span>
			{unique.map((url) => (
				<button
					key={url}
					type="button"
					onClick={() => onSelect(url)}
					className="rounded border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
				>
					{isIncognito ? getLinuxUrl(url) : url}
				</button>
			))}
		</div>
	);
};
