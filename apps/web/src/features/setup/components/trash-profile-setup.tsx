"use client";

import type { ServiceInstanceSummary, TrashTemplate } from "@arr/shared";
import { ArrowLeft, ArrowRight, CheckCircle2, Loader2, Package, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { lazy, Suspense, useMemo, useState } from "react";
import {
	Alert,
	AlertDescription,
	Badge,
	Button,
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
	NativeSelect,
	SelectOption,
} from "../../../components/ui";
import {
	useImportQualityProfile,
	useQualityProfileDetails,
	useQualityProfiles,
} from "../../../hooks/api/useQualityProfiles";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useTemplates } from "../../../hooks/api/useTemplates";
import { useRefreshTrashCache } from "../../../hooks/api/useTrashCache";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import type { QualityProfileDetailsResponse } from "../../../lib/api-client/trash-guides";
import { getErrorMessage } from "../../../lib/error-utils";
import { getLinuxInstanceName, useIncognitoMode } from "../../../lib/incognito";

const DeploymentPreviewModal = lazy(() =>
	import("../../trash-guides/components/deployment-preview-modal").then((module) => ({
		default: module.DeploymentPreviewModal,
	})),
);

type ServiceType = "RADARR" | "SONARR";

const toServiceType = (service: ServiceInstanceSummary): ServiceType =>
	service.service === "sonarr" ? "SONARR" : "RADARR";

const isDefault = (value: string | boolean | undefined) => value === true || value === "true";

export const buildSetupProfileSelections = (details: QualityProfileDetailsResponse) => {
	const customFormatSelections: Record<
		string,
		{ selected: boolean; conditionsEnabled: Record<string, boolean> }
	> = {};

	for (const format of details.mandatoryCFs) {
		customFormatSelections[format.trash_id] = { selected: true, conditionsEnabled: {} };
	}

	const selectedCFGroups: string[] = [];
	for (const group of details.cfGroups) {
		const groupDefault = group.defaultEnabled === true || isDefault(group.default);
		let selectedInGroup = false;
		for (const format of group.custom_formats ?? []) {
			const trashId = typeof format === "string" ? format : format.trash_id;
			const selected =
				groupDefault &&
				typeof format !== "string" &&
				(format.required === true || isDefault(format.default) || format.defaultChecked === true);
			customFormatSelections[trashId] = { selected, conditionsEnabled: {} };
			selectedInGroup ||= selected;
		}
		if (selectedInGroup) selectedCFGroups.push(group.trash_id);
	}

	return { customFormatSelections, selectedCFGroups };
};

export const TrashProfileSetup = () => {
	const router = useRouter();
	const { gradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	const {
		data: services = [],
		isLoading: servicesLoading,
		error: servicesError,
	} = useServicesQuery();
	const arrServices = useMemo(
		() =>
			services.filter(
				(service) =>
					service.enabled && (service.service === "sonarr" || service.service === "radarr"),
			),
		[services],
	);
	const [instanceId, setInstanceId] = useState("");
	const selectedInstance = arrServices.find((service) => service.id === instanceId) ?? null;
	const serviceType = selectedInstance ? toServiceType(selectedInstance) : "RADARR";
	const [catalogReady, setCatalogReady] = useState(false);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [profileId, setProfileId] = useState("");
	const [previewTemplate, setPreviewTemplate] = useState<TrashTemplate | null>(null);
	const [deployed, setDeployed] = useState(false);
	const refreshCache = useRefreshTrashCache();
	const profiles = useQualityProfiles(serviceType, { enabled: catalogReady });
	const profileDetails = useQualityProfileDetails(serviceType, profileId, catalogReady);
	const templates = useTemplates({ serviceType });
	const importProfile = useImportQualityProfile();
	const selectedProfile = profiles.data?.profiles.find((profile) => profile.trashId === profileId);
	const existingTemplate = templates.data?.templates.find(
		(template) => template.sourceQualityProfileTrashId === profileId,
	);

	const handleInstanceChange = (value: string) => {
		setInstanceId(value);
		setCatalogReady(false);
		setCatalogError(null);
		setProfileId("");
		setPreviewTemplate(null);
	};

	const loadCatalog = async () => {
		if (!selectedInstance) return;
		setCatalogError(null);
		try {
			const result = await refreshCache.mutateAsync({ serviceType, force: false });
			for (const requiredType of ["QUALITY_PROFILES", "CUSTOM_FORMATS", "CF_GROUPS"] as const) {
				const status = result.results?.[requiredType] as
					| { success?: boolean; error?: string }
					| undefined;
				if (status?.success === false) {
					throw new Error(status.error || `Failed to load ${requiredType}`);
				}
			}
			setCatalogReady(true);
		} catch (loadError) {
			setCatalogError(getErrorMessage(loadError, "Failed to load the TRaSH profile catalog"));
		}
	};

	const preparePreview = async () => {
		if (!selectedInstance || !selectedProfile || !profileDetails.data) return;
		if (existingTemplate) {
			setPreviewTemplate(existingTemplate);
			return;
		}
		const selections = buildSetupProfileSelections(profileDetails.data);
		const result = await importProfile.mutateAsync({
			serviceType,
			trashId: selectedProfile.trashId,
			templateName: selectedProfile.name,
			selectedCFGroups: selections.selectedCFGroups,
			customFormatSelections: selections.customFormatSelections,
		});
		setPreviewTemplate(result.template);
	};

	const error =
		servicesError ||
		refreshCache.error ||
		profiles.error ||
		profileDetails.error ||
		importProfile.error;
	const profileLoading =
		catalogReady && (profiles.isLoading || (Boolean(profileId) && profileDetails.isLoading));

	return (
		<div className="w-full max-w-4xl space-y-6 pb-24 pt-8">
			<div className="space-y-3 text-center">
				<p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">Step 4 of 5</p>
				<h1
					className="text-3xl font-bold tracking-tight"
					style={{
						background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
						WebkitBackgroundClip: "text",
						WebkitTextFillColor: "transparent",
					}}
				>
					Choose your TRaSH profile
				</h1>
				<p className="mx-auto max-w-2xl text-muted-foreground">
					Pick the target and official profile yourself. Setup prepares the same detailed preview
					used by TRaSH Guides before any Sonarr or Radarr settings change.
				</p>
			</div>

			{deployed && (
				<Alert>
					<CheckCircle2 className="h-4 w-4" />
					<AlertDescription>The selected profile was deployed after review.</AlertDescription>
				</Alert>
			)}

			<Card className="border-border/50 bg-card/80">
				<CardHeader>
					<CardTitle>Profile deployment</CardTitle>
					<CardDescription>
						This step is optional. No target or profile is preselected.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-5">
					{servicesLoading ? (
						<div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
							<Loader2 className="h-4 w-4 animate-spin" /> Loading connected services…
						</div>
					) : arrServices.length === 0 ? (
						<Alert>
							<AlertDescription>
								Connect an enabled Sonarr or Radarr instance to prepare a TRaSH profile deployment.
							</AlertDescription>
						</Alert>
					) : (
						<>
							<label className="space-y-2 text-sm" htmlFor="setup-trash-instance">
								<span className="font-medium">Target instance</span>
								<NativeSelect
									id="setup-trash-instance"
									value={instanceId}
									onChange={(event) => handleInstanceChange(event.target.value)}
								>
									<SelectOption value="">Choose Sonarr or Radarr</SelectOption>
									{arrServices.map((service) => (
										<SelectOption key={service.id} value={service.id}>
											{incognitoMode ? getLinuxInstanceName(service.label) : service.label} (
											{service.service})
										</SelectOption>
									))}
								</NativeSelect>
							</label>

							{selectedInstance && !catalogReady && (
								<Button
									type="button"
									variant="outline"
									onClick={loadCatalog}
									disabled={refreshCache.isPending}
								>
									{refreshCache.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
									Load official {serviceType === "SONARR" ? "Sonarr" : "Radarr"} profiles
								</Button>
							)}

							{catalogReady && (
								<label className="space-y-2 text-sm" htmlFor="setup-trash-profile">
									<span className="font-medium">Official quality profile</span>
									<NativeSelect
										id="setup-trash-profile"
										value={profileId}
										onChange={(event) => {
											setProfileId(event.target.value);
											setPreviewTemplate(null);
										}}
										disabled={profiles.isLoading}
									>
										<SelectOption value="">Choose a profile</SelectOption>
										{profiles.data?.profiles.map((profile) => (
											<SelectOption key={profile.trashId} value={profile.trashId}>
												{profile.name}
											</SelectOption>
										))}
									</NativeSelect>
								</label>
							)}

							{profileLoading && (
								<div className="flex items-center gap-2 text-sm text-muted-foreground">
									<Loader2 className="h-4 w-4 animate-spin" /> Loading profile details…
								</div>
							)}

							{selectedProfile && profileDetails.data && (
								<div className="space-y-3 rounded-xl border border-border/60 p-4">
									<div className="flex flex-wrap items-center gap-2">
										<Package className="h-4 w-4" style={{ color: gradient.from }} />
										<span className="font-medium">{selectedProfile.name}</span>
										{existingTemplate && <Badge variant="secondary">Template already exists</Badge>}
									</div>
									<p className="text-sm text-muted-foreground">
										{selectedProfile.customFormatCount} profile formats ·{" "}
										{selectedProfile.qualityCount} quality entries · cutoff {selectedProfile.cutoff}
									</p>
									<p className="text-sm">
										Preparing the preview may create a reusable local template. It does not change
										the selected instance.
									</p>
									<Button type="button" onClick={preparePreview} disabled={importProfile.isPending}>
										{importProfile.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
										Review deployment preview
									</Button>
								</div>
							)}
						</>
					)}
				</CardContent>
			</Card>

			<Card className="border-border/50 bg-card/80">
				<CardContent className="flex items-start gap-3 p-4">
					<ShieldCheck className="mt-0.5 h-5 w-5" style={{ color: gradient.to }} />
					<div>
						<p className="font-medium">External writes remain confirmation-gated</p>
						<p className="mt-1 text-sm text-muted-foreground">
							Loading profiles and preparing a preview only update arr-dashboard’s local catalog and
							template. Sonarr or Radarr changes only after you explicitly deploy from the preview.
						</p>
					</div>
				</CardContent>
			</Card>

			{(catalogError || error) && (
				<Alert variant="destructive">
					<AlertDescription>{catalogError || getErrorMessage(error)}</AlertDescription>
				</Alert>
			)}

			<div className="flex flex-wrap items-center justify-between gap-3">
				<Button type="button" variant="ghost" onClick={() => router.push("/setup?stage=starters")}>
					<ArrowLeft className="h-4 w-4" /> Back to starters
				</Button>
				<Button type="button" size="lg" onClick={() => router.push("/setup?stage=console")}>
					Continue{!deployed && " without deploying"}
					<ArrowRight className="h-4 w-4" />
				</Button>
			</div>

			{previewTemplate && (
				<Suspense fallback={null}>
					<DeploymentPreviewModal
						open
						onClose={() => setPreviewTemplate(null)}
						templateId={previewTemplate.id}
						templateName={previewTemplate.name}
						instanceId={selectedInstance?.id ?? null}
						instanceLabel={selectedInstance?.label}
						onDeploySuccess={() => setDeployed(true)}
					/>
				</Suspense>
			)}
		</div>
	);
};
