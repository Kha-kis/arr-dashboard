"use client";

import type {
	ProviderInventoryConnection,
	ProviderNativeInventoryAttempt,
	ProviderNativeInventoryResponse,
	ProviderNativeWatchDisplay,
	ServiceInstanceSummary,
} from "@arr/shared";
import { Database, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Badge,
	Button,
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	NativeSelect,
	SelectOption,
} from "../../../components/ui";
import { useProviderNativeInventory } from "../../../hooks/api/useProviderNativeInventory";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { getLinuxInstanceName, getLinuxIsoName, useIncognitoMode } from "../../../lib/incognito";
import { NativeWatchCoverageNotice } from "./native-watch-coverage-notice";

const SUPPORTED_SERVICES = new Set(["plex", "jellyfin", "emby"]);
type InventoryDomain = "library" | "episode";

function providerLabel(service: ServiceInstanceSummary["service"]): string {
	return service === "emby" ? "Emby" : service === "jellyfin" ? "Jellyfin" : "Plex";
}

function formatObservedAt(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "Recorded time unavailable" : date.toLocaleString();
}

function isAvailable(
	data: ProviderNativeInventoryResponse | undefined,
): data is Extract<ProviderNativeInventoryResponse, { status: "available" }> {
	return data?.status === "available";
}

function unavailableMessage(
	reason: Extract<ProviderNativeInventoryResponse, { status: "unavailable" }>["reason"],
): string {
	switch (reason) {
		case "not-owned":
			return "This provider is no longer available to your account.";
		case "provider-unavailable":
			return "The provider connection is unavailable.";
		case "identity-changed":
			return "The provider identity changed, so a new scan is required.";
		case "no-publication":
			return "No provider inventory scan has been published yet.";
		case "snapshot-changed":
			return "The inventory changed while you were browsing. Reload to see the latest scan.";
		case "filter-limit-exceeded":
			return "This inventory is too large for the metadata filter. The unfiltered inventory is still available.";
		case "unsupported-provider":
			return "This metadata filter is available only for Plex inventory.";
		case "malformed-publication":
			return "The recorded provider inventory could not be read.";
	}
}

function connectionStatusLabel(status: ProviderInventoryConnection["status"]): string {
	switch (status) {
		case "matched":
			return "Matched ARR item";
		case "unmatched":
			return "No ARR match";
		case "ambiguous":
			return "Ambiguous ARR match";
		case "unknown":
			return "ARR match unknown";
	}
}

function connectionReasonLabel(reason: string): string {
	switch (reason) {
		case "matched-identifiers":
			return "Matched by provider identifiers";
		case "no-arr-match":
			return "No matching Radarr or Sonarr record was found";
		case "missing-identifiers":
			return "Provider identifiers are missing or invalid";
		case "conflicting-identifiers":
			return "Provider identifiers conflict, so this remains unconfirmed";
		case "multiple-arr-items":
			return "More than one ARR record matches these identifiers";
		case "arr-catalog-unavailable":
			return "ARR catalog could not be checked";
		case "parent-unavailable":
			return "The parent series connection could not be confirmed";
		default:
			return "Connection evidence is unconfirmed";
	}
}

function connectionStatusClass(status: ProviderInventoryConnection["status"]): string {
	switch (status) {
		case "matched":
			return "text-emerald-500";
		case "unmatched":
			return "text-muted-foreground";
		case "ambiguous":
		case "unknown":
			return "text-amber-500";
	}
}

function watchLabel(state: ProviderNativeWatchDisplay["state"]): string {
	switch (state) {
		case "watched":
			return "Watched";
		case "unwatched":
			return "Unwatched";
		case "unknown":
			return "Watch state unknown";
	}
}

function attemptHeading(state: ProviderNativeInventoryAttempt["state"]): string | null {
	switch (state) {
		case "pending":
			return "Inventory scan is scheduled";
		case "running":
			return "Inventory scan in progress";
		case "ready":
			return "Inventory scan is being verified";
		case "incomplete":
			return "Inventory scan could not verify complete coverage";
		case "superseded":
			return "Inventory scan was superseded";
		case "unknown":
			return "Inventory scan state is unverified";
		case "published":
			return null;
	}
}

function attemptReason(reason: ProviderNativeInventoryAttempt["reasonCode"]): string | null {
	switch (reason) {
		case "provider-unavailable":
			return "The provider request was unavailable.";
		case "coverage-incomplete":
			return "Provider coverage changed or was incomplete.";
		case "deadline-exceeded":
			return "A page request exceeded its time limit.";
		case "database-retryable":
			return "Inventory storage was temporarily busy.";
		case "budget-exhausted":
			return "The scan exceeded its bounded work budget.";
		case null:
			return null;
	}
}

export function ProviderNativeInventoryPanel() {
	const servicesQuery = useServicesQuery();
	const [incognitoMode] = useIncognitoMode();
	const supportedServices = useMemo(
		() =>
			(servicesQuery.data ?? []).filter(
				(service) => service.enabled && SUPPORTED_SERVICES.has(service.service),
			),
		[servicesQuery.data],
	);
	const [instanceId, setInstanceId] = useState("");
	const [domain, setDomain] = useState<InventoryDomain>("library");
	const [metadataFilter, setMetadataFilter] = useState<"missing-tmdb" | null>(null);
	const [afterNativeId, setAfterNativeId] = useState<string | null>(null);
	const [expectedGenerationId, setExpectedGenerationId] = useState<string | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);
	const initialLinkApplied = useRef(false);

	const resetPagination = useCallback(() => {
		setAfterNativeId(null);
		setExpectedGenerationId(null);
	}, []);

	useEffect(() => {
		if (supportedServices.length === 0) {
			if (instanceId) setInstanceId("");
			return;
		}
		if (!supportedServices.some((service) => service.id === instanceId)) {
			setInstanceId(supportedServices[0]?.id ?? "");
			resetPagination();
		}
	}, [instanceId, resetPagination, supportedServices]);
	useEffect(() => {
		if (initialLinkApplied.current || !servicesQuery.isSuccess || supportedServices.length === 0)
			return;
		const params = new URLSearchParams(window.location.search);
		const linkedInstanceId = params.get("inventoryInstanceId");
		const linkedDomain = params.get("inventoryDomain");
		const linkedMetadataFilter = params.get("inventoryMetadataFilter");
		if (
			linkedInstanceId &&
			supportedServices.some((service) => service.id === linkedInstanceId) &&
			(linkedDomain === "library" || linkedDomain === "episode")
		) {
			initialLinkApplied.current = true;
			setInstanceId(linkedInstanceId);
			setDomain(linkedDomain);
			setMetadataFilter(
				linkedDomain === "library" &&
					linkedMetadataFilter === "missing-tmdb" &&
					supportedServices.some(
						(service) => service.id === linkedInstanceId && service.service === "plex",
					)
					? "missing-tmdb"
					: null,
			);
			resetPagination();
		}
	}, [resetPagination, servicesQuery.isSuccess, supportedServices]);
	const selectedService = supportedServices.find((service) => service.id === instanceId);
	const activeMetadataFilter =
		domain === "library" && selectedService?.service === "plex" ? metadataFilter : null;

	const inventoryQuery = useProviderNativeInventory({
		instanceId: instanceId || null,
		domain,
		metadataFilter: activeMetadataFilter,
		afterNativeId,
		expectedGenerationId,
		refreshKey,
		enabled: servicesQuery.isSuccess && supportedServices.length > 0,
	});

	const data = inventoryQuery.data;
	const available = isAvailable(data) ? data : undefined;
	const attempt = data?.attempt;
	const serviceLabels = useMemo(
		() => new Map((servicesQuery.data ?? []).map((service) => [service.id, service.label])),
		[servicesQuery.data],
	);
	const showLoading =
		inventoryQuery.isLoading || (Boolean(instanceId) && !data && inventoryQuery.isFetching);
	const showUnconfirmed =
		available !== undefined &&
		(inventoryQuery.isError ||
			available.evidence === "positive-only" ||
			available.freshness !== "current" ||
			!available.complete ||
			available.lastAttemptResult !== "success");

	if (servicesQuery.isSuccess && supportedServices.length === 0) return null;

	const setScope = (nextInstanceId: string, nextDomain: InventoryDomain) => {
		initialLinkApplied.current = true;
		setInstanceId(nextInstanceId);
		setDomain(nextDomain);
		if (
			nextDomain !== "library" ||
			!supportedServices.some(
				(service) => service.id === nextInstanceId && service.service === "plex",
			)
		) {
			setMetadataFilter(null);
		}
		resetPagination();
	};

	const handleReload = () => {
		if (afterNativeId === null && expectedGenerationId === null) {
			void inventoryQuery.refetch();
			return;
		}
		resetPagination();
		setRefreshKey((value) => value + 1);
	};

	const handleServicesReload = () => {
		void servicesQuery.refetch();
	};

	return (
		<Card
			id="media-server-inventory"
			className="mt-4 scroll-mt-24"
			data-testid="provider-native-inventory-panel"
		>
			<CardHeader className="flex flex-row items-center justify-between gap-3 pb-3">
				<CardTitle className="flex items-center gap-2 text-base">
					<Database className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
					Media server inventory
				</CardTitle>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={handleReload}
					disabled={inventoryQuery.isFetching}
					aria-label="Reload media server inventory"
				>
					<RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
					Reload
				</Button>
			</CardHeader>
			<CardContent className="space-y-4">
				{servicesQuery.isLoading && (
					<div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
						<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
						Loading media server connections…
					</div>
				)}
				{servicesQuery.isError && (
					<div className="flex flex-wrap items-center gap-3 text-sm" role="alert">
						<span className="text-muted-foreground">Could not load media server connections.</span>
						<Button type="button" variant="outline" size="sm" onClick={handleServicesReload}>
							Reload services
						</Button>
					</div>
				)}
				<div className="grid gap-3 sm:grid-cols-3">
					<label className="space-y-1 text-sm" htmlFor="provider-native-inventory-provider">
						<span className="text-xs font-medium text-muted-foreground">Provider</span>
						<NativeSelect
							id="provider-native-inventory-provider"
							aria-label="Provider"
							value={instanceId}
							onChange={(event) => setScope(event.target.value, domain)}
							disabled={supportedServices.length === 0}
						>
							{supportedServices.map((service) => (
								<SelectOption value={service.id} key={service.id}>
									{incognitoMode ? getLinuxInstanceName(service.label) : service.label} (
									{providerLabel(service.service)})
								</SelectOption>
							))}
						</NativeSelect>
					</label>
					<label className="space-y-1 text-sm" htmlFor="provider-native-inventory-domain">
						<span className="text-xs font-medium text-muted-foreground">Inventory</span>
						<NativeSelect
							id="provider-native-inventory-domain"
							aria-label="Inventory domain"
							value={domain}
							onChange={(event) => setScope(instanceId, event.target.value as InventoryDomain)}
						>
							<SelectOption value="library">Movies and series</SelectOption>
							<SelectOption value="episode">Episodes</SelectOption>
						</NativeSelect>
					</label>
					{selectedService?.service === "plex" && domain === "library" && (
						<label className="space-y-1 text-sm" htmlFor="provider-native-inventory-filter">
							<span className="text-xs font-medium text-muted-foreground">Inventory filter</span>
							<NativeSelect
								id="provider-native-inventory-filter"
								aria-label="Inventory filter"
								value={activeMetadataFilter ?? "all"}
								onChange={(event) => {
									setMetadataFilter(event.target.value === "missing-tmdb" ? "missing-tmdb" : null);
									resetPagination();
								}}
							>
								<SelectOption value="all">All items</SelectOption>
								<SelectOption value="missing-tmdb">Missing Plex metadata</SelectOption>
							</NativeSelect>
						</label>
					)}
				</div>

				{showLoading && (
					<div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
						<Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
						Loading recorded inventory…
					</div>
				)}
				{inventoryQuery.isError && (
					<p className="text-sm text-muted-foreground" role="alert">
						Inventory is unavailable right now. The current contents are unconfirmed.
					</p>
				)}
				{!showLoading && !inventoryQuery.isError && data?.status === "unavailable" && (
					<p className="text-sm text-muted-foreground" role="status">
						{unavailableMessage(data.reason)}
					</p>
				)}
				{attempt && attemptHeading(attempt.state) && (
					<div className="space-y-1 text-sm text-muted-foreground" role="status" aria-live="polite">
						<p className="font-medium">{attemptHeading(attempt.state)}</p>
						<p className="text-xs">
							Pass {attempt.passOrdinal} · {attempt.pagesCompleted} pages · {attempt.itemsStaged}{" "}
							items staged. Staged items are not published until coverage is verified.
						</p>
						{attemptReason(attempt.reasonCode) && (
							<p className="text-xs">{attemptReason(attempt.reasonCode)}</p>
						)}
					</div>
				)}
				{available && (
					<>
						<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
							<span className="font-medium">
								{available.evidence === "positive-only"
									? "Observed items (partial coverage)"
									: showUnconfirmed
										? "Last known inventory"
										: "Complete at last scan"}
							</span>
							<span className="text-muted-foreground">
								{activeMetadataFilter === "missing-tmdb"
									? available.filteredItemCount === undefined
										? "Filtered item count is unavailable"
										: `${available.filteredItemCount.toLocaleString()} of ${available.itemCount.toLocaleString()} recorded items need Plex metadata matching`
									: `${available.itemCount.toLocaleString()} recorded item${available.itemCount === 1 ? "" : "s"}`}
							</span>
						</div>
						<p className="text-xs text-muted-foreground">
							Observed {formatObservedAt(available.observedAt)}.{" "}
							{showUnconfirmed ? "The current scan is not confirmed." : ""}
						</p>
						<p className="text-xs text-muted-foreground">
							{activeMetadataFilter === "missing-tmdb"
								? "These recorded Plex items have no unique TMDb ID. Match their metadata in Plex, then allow the normal cache refresh. This list is not watch or cleanup authority."
								: available.evidence === "positive-only"
									? "These rows were observed in a completed scan, but missing items are not confirmed absent. This partial view is not cleanup authority."
									: "Every native item remains visible, including items without a Radarr or Sonarr match. Inventory is provider presence. Watch badges are separate display evidence, not cleanup authority."}
						</p>
						{domain === "episode" && (
							<p className="text-xs text-muted-foreground">
								{selectedService?.service === "plex"
									? "Plex watch badges use positive watched observations only. "
									: ""}
								Unknown means watch observations were not verified. Absence is not proof of
								unwatched.
							</p>
						)}
						{domain === "episode" && available.watchCoverage ? (
							<NativeWatchCoverageNotice coverage={available.watchCoverage} />
						) : null}
						{available.rows.length > 0 && (
							<ul
								className="divide-y divide-border rounded-lg border border-border/60"
								aria-label="Inventory items"
							>
								{available.rows.map((row) => (
									<li
										className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-sm"
										key={`${row.mediaType}:${row.nativeId}`}
									>
										<div className="min-w-0 space-y-1">
											<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
												<span className="truncate">
													{incognitoMode
														? getLinuxIsoName(row.title || row.nativeId)
														: row.title || "Untitled item"}
												</span>
												<span className="text-xs text-muted-foreground">
													{row.mediaType}
													{row.mediaType === "episode" &&
													(row.seasonNumber !== null || row.episodeNumber !== null)
														? ` · S${row.seasonNumber ?? "?"}E${row.episodeNumber ?? "?"}`
														: ""}
												</span>
											</div>
											{selectedService?.service === "plex" &&
												domain === "library" &&
												row.mediaType !== "episode" &&
												row.externalIds?.tmdb?.length !== 1 && (
													<div className="flex flex-col items-start gap-1 text-xs">
														<Badge variant="warning">Metadata review needed</Badge>
														<span className="text-muted-foreground">No unique TMDB mapping</span>
														<details className="text-muted-foreground">
															<summary className="cursor-pointer rounded-sm py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
																Check matching in Plex
															</summary>
															<p className="mt-1 break-words">
																Review this item&apos;s metadata match in Plex, then allow the
																normal cache refresh. A missing or conflicting TMDB ID does not
																prove this item is unmatched. The notice clears after verified
																inventory records a unique mapping. Reviewing metadata does not
																change watch state or cleanup eligibility.
															</p>
														</details>
													</div>
												)}
											{row.mediaType === "episode" && row.watch && (
												<div className="flex flex-wrap items-center gap-2 text-xs">
													<Badge
														variant={
															row.watch.state === "watched"
																? "success"
																: row.watch.state === "unwatched"
																	? "secondary"
																	: "outline"
														}
													>
														{watchLabel(row.watch.state)}
													</Badge>
													{row.watch.freshness !== "unavailable" && (
														<span className="text-muted-foreground">
															{row.watch.freshness === "current" ? "Current" : "Last known"}
														</span>
													)}
													{row.watch.valueSemantics === "lower-bound" && (
														<span className="text-muted-foreground">Lower bound</span>
													)}
												</div>
											)}
											{row.connection && (
												<div className="space-y-0.5 text-xs">
													<span className={`block ${connectionStatusClass(row.connection.status)}`}>
														{connectionStatusLabel(row.connection.status)}
													</span>
													<span className="text-muted-foreground">
														{connectionReasonLabel(row.connection.reason)}
													</span>
													{row.connection.arrItems.length > 0 && (
														<ul className="space-y-0.5">
															{row.connection.arrItems.map((arrItem) => (
																<li
																	key={`${arrItem.instanceId}:${arrItem.itemType}:${arrItem.arrItemId}`}
																>
																	{row.mediaType === "episode" ? "ARR parent series: " : "ARR: "}
																	{incognitoMode ? getLinuxIsoName(arrItem.title) : arrItem.title}
																	{serviceLabels.get(arrItem.instanceId)
																		? ` (${incognitoMode ? getLinuxInstanceName(serviceLabels.get(arrItem.instanceId)!) : serviceLabels.get(arrItem.instanceId)})`
																		: ""}
																</li>
															))}
														</ul>
													)}
												</div>
											)}
										</div>
									</li>
								))}
							</ul>
						)}
						{available.nextNativeId && (
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={inventoryQuery.isFetching}
								onClick={() => {
									setAfterNativeId(available.nextNativeId);
									setExpectedGenerationId(available.generationId);
								}}
							>
								Next page
							</Button>
						)}
					</>
				)}
			</CardContent>
		</Card>
	);
}
