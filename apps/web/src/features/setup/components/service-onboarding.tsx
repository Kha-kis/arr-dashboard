"use client";

import type { SetupDiscoveryCandidate } from "@arr/shared";
import { ArrowRight, Check, Loader2, Radar, Server } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
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
} from "../../../components/ui";
import {
	useCreateServiceMutation,
	useTestConnectionBeforeAdd,
} from "../../../hooks/api/useServiceMutations";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useSetupDiscovery } from "../../../hooks/api/useSetupDiscovery";
import { useUpdateAnalyticsProviderSelection } from "../../../hooks/api/useSystem";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getErrorMessage } from "../../../lib/error-utils";
import { getLinuxServerName, getLinuxUrl, useIncognitoMode } from "../../../lib/incognito";
import { SERVICE_TYPES, type ServiceType } from "../../settings/lib/settings-constants";
import {
	getServicePlaceholders,
	supportsHttpBasicAuth,
	usesPlainHttp,
} from "../../settings/lib/settings-utils";

interface ServiceDraft {
	service: ServiceType;
	label: string;
	baseUrl: string;
	apiKey: string;
	httpAuthEnabled: boolean;
	httpAuthUsername: string;
	httpAuthPassword: string;
}

const emptyDraft = (service: ServiceType = "sonarr"): ServiceDraft => {
	const placeholders = getServicePlaceholders(service);
	return {
		service,
		label: placeholders.label,
		baseUrl: "",
		apiKey: "",
		httpAuthEnabled: false,
		httpAuthUsername: "",
		httpAuthPassword: "",
	};
};

const candidateDraft = (candidate: SetupDiscoveryCandidate): ServiceDraft => ({
	service: candidate.service,
	label: candidate.name,
	baseUrl: candidate.baseUrl,
	apiKey: "",
	httpAuthEnabled: false,
	httpAuthUsername: "",
	httpAuthPassword: "",
});

export const ServiceOnboarding = () => {
	const router = useRouter();
	const { gradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	const discovery = useSetupDiscovery();
	const createService = useCreateServiceMutation();
	const updateAnalyticsProvider = useUpdateAnalyticsProviderSelection();
	const testConnection = useTestConnectionBeforeAdd();
	const { data: services = [], isLoading: servicesLoading } = useServicesQuery();
	const [draft, setDraft] = useState<ServiceDraft | null>(null);
	const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);

	const candidates = useMemo(
		() =>
			(discovery.data?.candidates ?? []).filter(
				(candidate) =>
					!services.some(
						(service) =>
							service.service === candidate.service && service.baseUrl === candidate.baseUrl,
					),
			),
		[discovery.data?.candidates, services],
	);

	const selectService = (service: ServiceType) => {
		setDraft(emptyDraft(service));
		setResult(null);
	};

	const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!draft) return;

		const payload = {
			service: draft.service,
			label: draft.label.trim(),
			baseUrl: draft.baseUrl.trim(),
			apiKey: draft.apiKey.trim(),
			httpAuth:
				draft.httpAuthEnabled && supportsHttpBasicAuth(draft.service)
					? { username: draft.httpAuthUsername.trim(), password: draft.httpAuthPassword }
					: undefined,
		};
		if (!payload.label || !payload.baseUrl || payload.apiKey.length < 8) {
			setResult({
				success: false,
				message: "Enter a label, a full URL, and an API key of at least 8 characters.",
			});
			return;
		}
		if (draft.httpAuthEnabled && (!payload.httpAuth?.username || !payload.httpAuth.password)) {
			setResult({ success: false, message: "Enter both HTTP Basic Auth fields." });
			return;
		}

		setResult(null);
		try {
			const connection = await testConnection.mutateAsync(payload);
			if (!connection.success) {
				setResult({
					success: false,
					message: connection.details ?? connection.error ?? "Connection could not be verified.",
				});
				return;
			}

			await createService.mutateAsync({
				...payload,
				enabled: true,
				isDefault: !services.some((service) => service.service === payload.service),
			});
			if (draft.service === "tautulli") {
				await updateAnalyticsProvider.mutateAsync({ provider: "tautulli" });
			}
			setDraft(null);
			setResult({ success: true, message: "Service connected successfully." });
		} catch (error) {
			setResult({ success: false, message: getErrorMessage(error, "Failed to add service") });
		}
	};

	const isSaving = testConnection.isPending || createService.isPending;

	return (
		<div className="w-full max-w-4xl space-y-6 py-8">
			<div className="space-y-3 text-center">
				<p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">Step 2 of 5</p>
				<h1
					className="text-3xl font-bold tracking-tight"
					style={{
						background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
						WebkitBackgroundClip: "text",
						WebkitTextFillColor: "transparent",
					}}
				>
					Connect your media stack
				</h1>
				<p className="mx-auto max-w-2xl text-muted-foreground">
					We scan only supported media-server discovery protocols. Sonarr, Radarr, and other
					services stay manual because they do not advertise a discovery protocol.
				</p>
			</div>

			<Card className="border-border/50 bg-card/80">
				<CardHeader>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div>
							<CardTitle className="flex items-center gap-2">
								<Radar className="h-5 w-5" /> Discovered media servers
							</CardTitle>
							<CardDescription>Review each candidate before connecting it.</CardDescription>
						</div>
						<Button
							type="button"
							variant="secondary"
							onClick={() => discovery.refetch()}
							disabled={discovery.isFetching}
						>
							{discovery.isFetching ? (
								<Loader2 className="h-4 w-4 animate-spin" />
							) : (
								<Radar className="h-4 w-4" />
							)}
							Scan again
						</Button>
					</div>
				</CardHeader>
				<CardContent className="space-y-3">
					{discovery.isLoading ? (
						<p className="text-sm text-muted-foreground">Scanning the local network…</p>
					) : candidates.length > 0 ? (
						<div className="grid gap-3 sm:grid-cols-2">
							{candidates.map((candidate) => (
								<div
									key={`${candidate.service}:${candidate.serverId ?? candidate.baseUrl}`}
									className="rounded-xl border border-border/60 p-4"
								>
									<p className="font-medium capitalize">{candidate.service}</p>
									<p className="text-sm text-foreground">
										{incognitoMode ? getLinuxServerName(candidate.name) : candidate.name}
									</p>
									<p className="truncate text-xs text-muted-foreground">
										{incognitoMode ? getLinuxUrl(candidate.baseUrl) : candidate.baseUrl}
									</p>
									<Button
										className="mt-3"
										size="sm"
										onClick={() => {
											setDraft(candidateDraft(candidate));
											setResult(null);
										}}
									>
										Configure
									</Button>
								</div>
							))}
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							No unconfigured media servers answered this scan. Discovery may not cross Docker
							bridges, VLANs, or subnets; manual setup works in every network layout.
						</p>
					)}
					{discovery.isError && (
						<Alert variant="danger">
							<AlertDescription>
								{getErrorMessage(discovery.error, "Discovery failed")}
							</AlertDescription>
						</Alert>
					)}
				</CardContent>
			</Card>

			<Card className="border-border/50 bg-card/80">
				<CardHeader>
					<CardTitle className="flex items-center gap-2">
						<Server className="h-5 w-5" /> Add a service
					</CardTitle>
					<CardDescription>
						Choose a discovered candidate above or enter any supported service manually.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<p className="text-sm text-muted-foreground">
						Tracearr is recommended for new analytics setups. Tautulli remains a supported
						alternative for existing Plex analytics setups. Choose one historical analytics
						provider.
					</p>
					<div className="flex flex-wrap gap-2">
						{SERVICE_TYPES.map((service) => (
							<Button
								key={service}
								type="button"
								size="sm"
								variant={draft?.service === service ? "default" : "outline"}
								onClick={() => selectService(service)}
								className="capitalize"
							>
								{service}
							</Button>
						))}
					</div>

					{draft && (
						<form className="grid gap-4 sm:grid-cols-2" onSubmit={handleSave} autoComplete="off">
							<label htmlFor="setup-service-label" className="space-y-2 text-sm">
								Label
								<Input
									id="setup-service-label"
									value={draft.label}
									onChange={(event) =>
										setDraft((current) =>
											current ? { ...current, label: event.target.value } : current,
										)
									}
									required
									maxLength={120}
								/>
							</label>
							<label htmlFor="setup-service-url" className="space-y-2 text-sm">
								Base URL
								<Input
									id="setup-service-url"
									type="url"
									value={draft.baseUrl}
									onChange={(event) =>
										setDraft((current) =>
											current ? { ...current, baseUrl: event.target.value } : current,
										)
									}
									placeholder={getServicePlaceholders(draft.service).baseUrl}
									required
									data-1p-ignore
								/>
							</label>
							<label htmlFor="setup-service-api-key" className="space-y-2 text-sm sm:col-span-2">
								API key
								<Input
									id="setup-service-api-key"
									type="password"
									value={draft.apiKey}
									onChange={(event) =>
										setDraft((current) =>
											current ? { ...current, apiKey: event.target.value } : current,
										)
									}
									required
									minLength={8}
									autoComplete="off"
									data-1p-ignore
								/>
							</label>
							<label className="flex items-center gap-2 text-sm sm:col-span-2">
								<input
									type="checkbox"
									checked={draft.httpAuthEnabled && supportsHttpBasicAuth(draft.service)}
									disabled={!supportsHttpBasicAuth(draft.service)}
									onChange={(event) =>
										setDraft((current) =>
											current ? { ...current, httpAuthEnabled: event.target.checked } : current,
										)
									}
								/>
								Reverse proxy HTTP Basic Auth
							</label>
							{!supportsHttpBasicAuth(draft.service) && (
								<p className="text-xs text-muted-foreground sm:col-span-2">
									{draft.service === "tracearr" ? "Tracearr" : "Jellyfin"} cannot combine Basic Auth
									with its API authentication. Configure a proxy bypass for arr-dashboard.
								</p>
							)}
							{draft.httpAuthEnabled && supportsHttpBasicAuth(draft.service) && (
								<>
									<label htmlFor="setup-http-username" className="space-y-2 text-sm">
										HTTP username
										<Input
											id="setup-http-username"
											value={draft.httpAuthUsername}
											onChange={(event) =>
												setDraft((current) =>
													current ? { ...current, httpAuthUsername: event.target.value } : current,
												)
											}
										/>
									</label>
									<label htmlFor="setup-http-password" className="space-y-2 text-sm">
										HTTP password
										<Input
											id="setup-http-password"
											type="password"
											value={draft.httpAuthPassword}
											onChange={(event) =>
												setDraft((current) =>
													current ? { ...current, httpAuthPassword: event.target.value } : current,
												)
											}
											autoComplete="new-password"
										/>
									</label>
								</>
							)}
							{draft.httpAuthEnabled &&
								supportsHttpBasicAuth(draft.service) &&
								usesPlainHttp(draft.baseUrl) && (
									<Alert variant="warning" className="sm:col-span-2">
										<AlertDescription>
											HTTP Basic credentials are readable on the network when the service URL uses
											http://. Use HTTPS unless this is a trusted private network.
										</AlertDescription>
									</Alert>
								)}
							<div className="flex gap-2 sm:col-span-2">
								<Button type="submit" disabled={isSaving}>
									{isSaving && <Loader2 className="h-4 w-4 animate-spin" />} Test and add
								</Button>
								<Button
									type="button"
									variant="ghost"
									onClick={() => {
										setDraft(null);
										setResult(null);
									}}
								>
									Cancel
								</Button>
							</div>
						</form>
					)}

					{result && (
						<Alert variant={result.success ? "success" : "danger"}>
							<AlertDescription>{result.message}</AlertDescription>
						</Alert>
					)}

					<div className="space-y-2 border-t border-border/50 pt-4">
						<p className="text-sm font-medium">Connected during setup</p>
						{servicesLoading ? (
							<p className="text-sm text-muted-foreground">Loading services…</p>
						) : services.length > 0 ? (
							<ul className="space-y-2">
								{services.map((service) => (
									<li key={service.id} className="flex items-center gap-2 text-sm">
										<Check className="h-4 w-4" />
										<span className="capitalize">{service.service}</span>
										<span>{incognitoMode ? getLinuxServerName(service.label) : service.label}</span>
									</li>
								))}
							</ul>
						) : (
							<p className="text-sm text-muted-foreground">
								None yet. You can also add services later in Settings.
							</p>
						)}
					</div>
				</CardContent>
			</Card>

			<div className="flex justify-end">
				<Button type="button" size="lg" onClick={() => router.push("/setup?stage=starters")}>
					{services.length > 0 ? "Review and continue" : "Continue without services"}
					<ArrowRight className="h-4 w-4" />
				</Button>
			</div>
		</div>
	);
};
