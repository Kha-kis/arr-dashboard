"use client";

import { useState, useMemo } from "react";
import {
	Alert,
	AlertTitle,
	AlertDescription,
	Button,
	Card,
	CardHeader,
	CardTitle,
	CardDescription,
	CardContent,
	Select,
	SelectOption,
	Input,
	Badge,
	Skeleton,
	EmptyState,
	Dialog,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogContent,
	DialogFooter,
	toast,
} from "../../../components/ui";
import { Search, Package, Download, CheckCircle2, XCircle, Loader2, Info } from "lucide-react";
import { createSanitizedHtml } from "../../../lib/sanitize-html";
import { useCustomFormats, useCFDescriptions, useDeployMultipleCustomFormats } from "../hooks/use-custom-formats";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import type { CustomFormat } from "../../../lib/api-client/custom-formats";
import { cleanDescription } from "../lib/description-utils";

/**
 * Custom Formats Browser Component
 * Allows users to browse all available TRaSH Guides custom formats
 * and deploy them individually to instances without creating templates
 */
export const CustomFormatsBrowser = () => {
	const [selectedService, setSelectedService] = useState<"RADARR" | "SONARR" | "ALL">("ALL");
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedFormats, setSelectedFormats] = useState<Set<string>>(new Set());
	const [deployDialogOpen, setDeployDialogOpen] = useState(false);
	const [selectedInstance, setSelectedInstance] = useState("");
	const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
	const [selectedFormatForDetails, setSelectedFormatForDetails] = useState<(CustomFormat & { service: "RADARR" | "SONARR" }) | null>(null);

	// Fetch custom formats
	const { data: customFormatsData, isLoading, error } = useCustomFormats(
		selectedService === "ALL" ? undefined : selectedService
	);

	// Fetch CF descriptions
	const { data: cfDescriptionsData } = useCFDescriptions(
		selectedService === "ALL" ? undefined : selectedService
	);

	// Fetch instances
	const { data: instances } = useServicesQuery();

	// Deploy mutation
	const deployMutation = useDeployMultipleCustomFormats();

	// Combine and filter custom formats
	const customFormats = useMemo(() => {
		if (!customFormatsData) return [];

		const formats: Array<CustomFormat & { service: "RADARR" | "SONARR" }> = [];

		if (customFormatsData.radarr) {
			formats.push(...customFormatsData.radarr.map(cf => ({ ...cf, service: "RADARR" as const })));
		}

		if (customFormatsData.sonarr) {
			formats.push(...customFormatsData.sonarr.map(cf => ({ ...cf, service: "SONARR" as const })));
		}

		// Filter by search query
		if (searchQuery) {
			return formats.filter(cf =>
				cf.name.toLowerCase().includes(searchQuery.toLowerCase())
			);
		}

		return formats;
	}, [customFormatsData, searchQuery]);

	// Get available instances for selected service
	const availableInstances = useMemo(() => {
		if (!instances) return [];

		const selectedFormatsArray = Array.from(selectedFormats);
		if (selectedFormatsArray.length === 0) return [];

		// Determine which service types are selected
		// Selection keys are in format "SERVICE-trash_id"
		const selectedServicesSet = new Set(
			selectedFormatsArray.map(selectionKey => {
				const [service] = selectionKey.split('-');
				return service;
			})
		);

		// If formats from both services are selected, show no instances
		if (selectedServicesSet.size > 1) {
			return [];
		}

		const service = Array.from(selectedServicesSet)[0];
		// Case-insensitive comparison since API returns lowercase "radarr"/"sonarr"
		return instances.filter(inst => inst.service.toUpperCase() === service);
	}, [instances, selectedFormats]);

	// Helper to create combined selection key
	const getSelectionKey = (format: { service: string; trash_id: string }) =>
		`${format.service}-${format.trash_id}`;

	// Handle format selection
	const toggleFormat = (selectionKey: string) => {
		const newSelection = new Set(selectedFormats);
		if (newSelection.has(selectionKey)) {
			newSelection.delete(selectionKey);
		} else {
			newSelection.add(selectionKey);
		}
		setSelectedFormats(newSelection);
	};

	// Handle select all
	const handleSelectAll = () => {
		if (selectedFormats.size === customFormats.length) {
			setSelectedFormats(new Set());
		} else {
			setSelectedFormats(new Set(customFormats.map(cf => getSelectionKey(cf))));
		}
	};

	// Get description for a custom format
	const getDescription = (format: CustomFormat & { service: "RADARR" | "SONARR" }) => {
		const service = format.service.toLowerCase() as "radarr" | "sonarr";
		const descriptions = cfDescriptionsData?.[service] || [];
		const slug = format.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
		return descriptions.find(d => d.cfName === slug);
	};

	// Handle view details
	const handleViewDetails = (format: CustomFormat & { service: "RADARR" | "SONARR" }) => {
		setSelectedFormatForDetails(format);
		setDetailsDialogOpen(true);
	};

	// Handle deploy
	const handleDeploy = () => {
		if (selectedFormats.size === 0) {
			toast.error("Please select at least one custom format");
			return;
		}
		setDeployDialogOpen(true);
	};

	const handleConfirmDeploy = async () => {
		if (!selectedInstance) {
			toast.error("Please select an instance");
			return;
		}

		const instance = instances?.find(inst => inst.id === selectedInstance);
		if (!instance) {
			toast.error("Instance not found");
			return;
		}

		try {
			// Extract trash_ids from combined selection keys (format: "SERVICE-trash_id")
			const trashIds = Array.from(selectedFormats).map(selectionKey => {
				// Split only on the first hyphen to handle trash_ids that may contain hyphens
				const firstHyphenIndex = selectionKey.indexOf('-');
				return selectionKey.slice(firstHyphenIndex + 1);
			});

			const result = await deployMutation.mutateAsync({
				trashIds,
				instanceId: selectedInstance,
				serviceType: instance.service.toUpperCase() as "RADARR" | "SONARR",
			});

			if (result.success) {
				toast.success(
					`Successfully deployed ${result.created.length + result.updated.length} custom formats`
				);
				setSelectedFormats(new Set());
				setDeployDialogOpen(false);
				setSelectedInstance("");
			} else {
				toast.error(
					`Deployed with errors: ${result.failed.length} failed`
				);
			}
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to deploy custom formats"
			);
		}
	};

	if (isLoading) {
		return (
			<div className="space-y-6">
				<div className="flex gap-4">
					<Skeleton className="h-10 w-48" />
					<Skeleton className="h-10 flex-1" />
				</div>
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{[...Array(6)].map((_, i) => (
						<Skeleton key={i} className="h-48" />
					))}
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<Alert variant="danger">
				<AlertTitle>Failed to load custom formats</AlertTitle>
				<AlertDescription>
					{error instanceof Error ? error.message : "Please refresh the page and try again."}
				</AlertDescription>
			</Alert>
		);
	}

	return (
		<div className="space-y-6">
			{/* Header and Controls */}
			<div className="rounded-lg border border-border bg-bg-subtle p-6">
				<div className="space-y-4">
					<div>
						<h3 className="text-lg font-semibold text-fg">Browse Custom Formats</h3>
						<p className="text-fg-muted mt-1">
							Browse and deploy individual TRaSH Guides custom formats directly to your instances
							without creating templates.
						</p>
					</div>

					<div className="flex flex-wrap gap-4">
						{/* Service Type Filter */}
						<Select
							value={selectedService}
							onChange={(e) => {
								setSelectedService(e.target.value as "RADARR" | "SONARR" | "ALL");
								setSelectedFormats(new Set());
							}}
						>
							<SelectOption value="ALL">All Services</SelectOption>
							<SelectOption value="RADARR">Radarr</SelectOption>
							<SelectOption value="SONARR">Sonarr</SelectOption>
						</Select>

						{/* Search */}
						<div className="relative flex-1 min-w-[200px]">
							<Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
							<Input
								type="text"
								placeholder="Search custom formats..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="pl-10"
							/>
						</div>

						{/* Selection Actions */}
						<div className="flex gap-2">
							<Button
								variant="secondary"
								size="sm"
								onClick={handleSelectAll}
							>
								{selectedFormats.size === customFormats.length ? "Deselect All" : "Select All"}
							</Button>
							<Button
								onClick={handleDeploy}
								disabled={selectedFormats.size === 0}
								className="flex items-center gap-2"
							>
								<Download className="h-4 w-4" />
								Deploy Selected ({selectedFormats.size})
							</Button>
						</div>
					</div>
				</div>
			</div>

			{/* Custom Formats Grid */}
			{customFormats.length === 0 ? (
				<EmptyState
					icon={Package}
					title="No custom formats found"
					description={
						searchQuery
							? "Try adjusting your search query"
							: "No custom formats available for the selected service"
					}
				/>
			) : (
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{customFormats.map((format) => {
						const selectionKey = getSelectionKey(format);
						return (
						<Card
							key={selectionKey}
							className={`flex flex-col cursor-pointer transition ${
								selectedFormats.has(selectionKey)
									? "ring-2 ring-primary bg-primary/10"
									: "hover:border-border"
							}`}
							onClick={() => toggleFormat(selectionKey)}
						>
							<CardHeader>
								<div className="flex items-start justify-between gap-2">
									<div className="flex-1 min-w-0">
										<CardTitle className="text-base truncate">
											{format.name}
										</CardTitle>
										<CardDescription className="mt-1">
											<Badge variant={format.service === "RADARR" ? "warning" : "info"}>
												{format.service}
											</Badge>
										</CardDescription>
									</div>
									{selectedFormats.has(selectionKey) && (
										<CheckCircle2 className="h-5 w-5 text-primary flex-shrink-0" />
									)}
								</div>
							</CardHeader>
							<CardContent className="flex flex-1 flex-col">
								{/* Variable height content */}
								<div className="flex-1 space-y-3">
									{/* Description */}
									{(() => {
										const description = getDescription(format);
										if (description && description.rawMarkdown) {
											const cleaned = cleanDescription(description.rawMarkdown, format.name);

											if (cleaned) {
												return (
													<p className="text-sm text-fg-muted">
														{cleaned}
													</p>
												);
											}
										}
										return null;
									})()}

									{/* Metadata */}
									<div className="flex items-center justify-between text-xs text-fg-muted">
										<span>{format.specifications.length} conditions</span>
									</div>
								</div>

								{/* Fixed bottom section */}
								<div className="mt-auto pt-3">
									{/* View Details Button */}
									<Button
										variant="secondary"
										size="sm"
										className="w-full"
										onClick={(e) => {
											e.stopPropagation();
											handleViewDetails(format);
										}}
									>
										<Info className="h-4 w-4 mr-2" />
										View Details
									</Button>
								</div>
							</CardContent>
						</Card>
						);
					})}
				</div>
			)}

			{/* Deploy Dialog */}
			<Dialog open={deployDialogOpen} onOpenChange={(open) => !open && setDeployDialogOpen(false)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Deploy Custom Formats</DialogTitle>
						<DialogDescription>
							Deploy {selectedFormats.size} selected custom format{selectedFormats.size !== 1 ? "s" : ""} to an instance
						</DialogDescription>
					</DialogHeader>

					<div className="space-y-4">
						{!instances || instances.length === 0 ? (
							<Alert variant="warning">
								<AlertTitle>No instances configured</AlertTitle>
								<AlertDescription>
									You need to configure at least one Radarr or Sonarr instance in Settings before you can deploy custom formats.
								</AlertDescription>
							</Alert>
						) : availableInstances.length === 0 ? (
							<Alert variant="warning">
								<AlertTitle>No compatible instances</AlertTitle>
								<AlertDescription>
									{selectedFormats.size > 0 && customFormats.length > 0
										? "The selected custom formats are from different services. Please select formats from only one service type (either all Radarr or all Sonarr)."
										: "No instances available for the selected custom formats."}
								</AlertDescription>
							</Alert>
						) : (
							<div className="space-y-2">
								<label className="text-sm font-medium text-fg">Select Instance</label>
								<Select
									value={selectedInstance}
									onChange={(e) => setSelectedInstance(e.target.value)}
								>
									<SelectOption value="">Choose an instance...</SelectOption>
									{availableInstances.map((instance) => (
										<SelectOption key={instance.id} value={instance.id}>
											{instance.label} ({instance.service})
										</SelectOption>
									))}
								</Select>
							</div>
						)}
					</div>

					<DialogFooter>
						<Button
							variant="secondary"
							onClick={() => setDeployDialogOpen(false)}
							disabled={deployMutation.isPending}
						>
							Cancel
						</Button>
						<Button
							onClick={handleConfirmDeploy}
							disabled={!selectedInstance || availableInstances.length === 0 || deployMutation.isPending}
						>
							{deployMutation.isPending ? (
								<>
									<Loader2 className="mr-2 h-4 w-4 animate-spin" />
									Deploying...
								</>
							) : (
								"Deploy"
							)}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Details Dialog */}
			<Dialog open={detailsDialogOpen} onOpenChange={(open) => !open && setDetailsDialogOpen(false)}>
				<DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{selectedFormatForDetails?.name}</DialogTitle>
						<DialogDescription>
							<Badge variant={selectedFormatForDetails?.service === "RADARR" ? "warning" : "info"}>
								{selectedFormatForDetails?.service}
							</Badge>
						</DialogDescription>
					</DialogHeader>

					{selectedFormatForDetails && (() => {
						// Find matching description using slug format (same as quality-profile-routes.ts)
						const service = selectedFormatForDetails.service.toLowerCase() as "radarr" | "sonarr";
						const descriptions = cfDescriptionsData?.[service] || [];
						const slug = selectedFormatForDetails.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
						const description = descriptions.find(d => d.cfName === slug);

						return (
							<div className="space-y-6">
								{/* Description */}
								{description && (
									<div className="space-y-2">
										<h3 className="text-sm font-semibold text-fg">Description</h3>
										<div
											className="rounded-lg border border-border bg-bg-subtle p-4 text-sm text-fg-muted prose prose-invert prose-sm max-w-none"
											dangerouslySetInnerHTML={createSanitizedHtml(description.description)}
										/>
									</div>
								)}

								{/* Metadata */}
								<div className="space-y-2">
									<h3 className="text-sm font-semibold text-fg">Information</h3>
									<div className="rounded-lg border border-border bg-bg-subtle p-4 space-y-2 text-sm">
										<div className="flex justify-between">
											<span className="text-fg-muted">TRaSH ID:</span>
											<span className="text-fg font-mono text-xs">{selectedFormatForDetails.trash_id}</span>
										</div>
										<div className="flex justify-between">
											<span className="text-fg-muted">Conditions:</span>
											<span className="text-fg">{selectedFormatForDetails.specifications.length}</span>
										</div>
									</div>
								</div>

							{/* Specifications/Conditions */}
							<div className="space-y-2">
								<h3 className="text-sm font-semibold text-fg">Conditions</h3>
								<div className="space-y-2">
									{selectedFormatForDetails.specifications.map((spec, index) => (
										<div key={index} className="rounded-lg border border-border bg-bg-subtle p-4">
											<div className="flex items-start justify-between mb-2">
												<div className="flex-1">
													<div className="font-medium text-fg">{spec.name}</div>
													<div className="text-xs text-fg-muted mt-1">
														{spec.implementation}
														{spec.negate && <Badge variant="warning" className="ml-2">Negated</Badge>}
														{spec.required && <Badge variant="default" className="ml-2">Required</Badge>}
													</div>
												</div>
											</div>
											{spec.fields && Object.keys(spec.fields).length > 0 && (
												<div className="mt-3 space-y-1">
													{Object.entries(spec.fields).map(([key, value]) => (
														<div key={key} className="text-xs">
															<span className="text-fg-muted">{key}:</span>{" "}
															<span className="text-fg-muted font-mono">
																{typeof value === 'object' ? JSON.stringify(value) : String(value)}
															</span>
														</div>
													))}
												</div>
											)}
										</div>
									))}
								</div>
							</div>
						</div>
						);
					})()}

					<DialogFooter>
						<Button variant="secondary" onClick={() => setDetailsDialogOpen(false)}>
							Close
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
};
