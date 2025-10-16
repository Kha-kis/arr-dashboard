/**
 * TRaSH Browser Modal
 * Browse and import custom formats from TRaSH Guides
 */

"use client";

import { useState } from "react";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	Button,
	Input,
	Badge,
	toast,
} from "../../../components/ui";
import { useTrashFormats, useTrashCFGroups, useImportCFGroup } from "../../../hooks/api/useTrashGuides";
import type { TrashCustomFormat } from "../../../lib/api-client/trash-guides";
import type { TrashCFGroup } from "../../../lib/api-client/trash-guides";

interface TrashBrowserModalProps {
	isOpen: boolean;
	onClose: () => void;
	instances: Array<{
		instanceId: string;
		instanceLabel: string;
		instanceService: string;
	}>;
	onSelectFormat?: (format: TrashCustomFormat, instanceId: string, service: string) => void;
	onImportMultiple?: (formats: TrashCustomFormat[], instanceId: string, service: string) => void;
}

type BrowseView = "formats" | "groups";

export function TrashBrowserModal({
	isOpen,
	onClose,
	instances,
	onSelectFormat,
	onImportMultiple,
}: TrashBrowserModalProps) {
	const [selectedInstanceId, setSelectedInstanceId] = useState<string>("");
	const [searchQuery, setSearchQuery] = useState("");
	const [selectedFormat, setSelectedFormat] = useState<TrashCustomFormat | null>(null);
	const [selectedFormats, setSelectedFormats] = useState<Set<string>>(new Set());
	const [browseView, setBrowseView] = useState<BrowseView>("formats");

	// Get selected instance details
	const selectedInstance = instances.find((i) => i.instanceId === selectedInstanceId);
	const service = selectedInstance?.instanceService as "SONARR" | "RADARR" | undefined;

	// Fetch data based on current view
	const { data: formatsData, isLoading: formatsLoading, error: formatsError } = useTrashFormats(service || "RADARR");
	const { data: groupsData, isLoading: groupsLoading, error: groupsError } = useTrashCFGroups(service || "RADARR");
	const cfGroupImportMutation = useImportCFGroup();

	const customFormats = formatsData?.customFormats || [];
	const cfGroups = groupsData?.cfGroups || [];

	const isLoading = browseView === "formats" ? formatsLoading : groupsLoading;
	const error = browseView === "formats" ? formatsError : groupsError;

	// Filter formats by search query
	const filteredFormats = customFormats.filter((format) =>
		format.name.toLowerCase().includes(searchQuery.toLowerCase())
	);

	// Filter CF groups by search query
	const filteredGroups = cfGroups.filter((group) =>
		group.name.toLowerCase().includes(searchQuery.toLowerCase())
	);

	const handleSelect = (format: TrashCustomFormat) => {
		if (onSelectFormat && selectedInstanceId && service) {
			onSelectFormat(format, selectedInstanceId, service);
			onClose();
		}
	};

	const toggleSelectFormat = (trashId: string) => {
		const newSelected = new Set(selectedFormats);
		if (newSelected.has(trashId)) {
			newSelected.delete(trashId);
		} else {
			newSelected.add(trashId);
		}
		setSelectedFormats(newSelected);
	};

	const toggleSelectAll = () => {
		if (selectedFormats.size === filteredFormats.length) {
			setSelectedFormats(new Set());
		} else {
			setSelectedFormats(new Set(filteredFormats.map((f) => f.trash_id)));
		}
	};

	const handleImportSelected = () => {
		if (selectedFormats.size === 0 || !selectedInstanceId || !service) return;

		const formatsToImport = customFormats.filter((f) => selectedFormats.has(f.trash_id));
		if (onImportMultiple) {
			onImportMultiple(formatsToImport, selectedInstanceId, service);
			setSelectedFormats(new Set());
			onClose();
		}
	};

	const handleInstanceChange = (newInstanceId: string) => {
		setSelectedInstanceId(newInstanceId);
		setSearchQuery("");
		setSelectedFormats(new Set());
	};

	const handleImportGroup = async (group: TrashCFGroup) => {
		if (!selectedInstanceId || !service) return;

		try {
			await cfGroupImportMutation.mutateAsync({
				instanceId: selectedInstanceId,
				groupFileName: group.fileName,
				service: service as "SONARR" | "RADARR",
			});
			toast.success(`Successfully imported ${group.custom_formats?.length || 0} custom formats from group: ${group.name}`);
			onClose();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to import CF group");
		}
	};

	const handleViewDetails = (format: TrashCustomFormat) => {
		setSelectedFormat(format);
	};

	const handleCloseDetails = () => {
		setSelectedFormat(null);
	};

	if (!isOpen) return null;

	return (
		<>
			{/* Main Browser Modal */}
			<Dialog open={isOpen && !selectedFormat} onOpenChange={onClose}>
				<DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
					<DialogHeader>
						<DialogTitle>Import from TRaSH Guides</DialogTitle>
						<DialogDescription>
							Select an instance and browse custom formats from TRaSH Guides
						</DialogDescription>
					</DialogHeader>

					{/* Instance selector */}
					<div className="space-y-2">
						<label htmlFor="trash-instance" className="text-sm font-medium text-fg">
							Select Instance
						</label>
						<select
							id="trash-instance"
							value={selectedInstanceId}
							onChange={(e) => handleInstanceChange(e.target.value)}
							className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg focus:ring-2 focus:ring-primary focus:ring-offset-2"
						>
							<option value="">Choose an instance...</option>
							{instances.map((instance) => (
								<option key={instance.instanceId} value={instance.instanceId}>
									{instance.instanceLabel} ({instance.instanceService})
								</option>
							))}
						</select>
					</div>

					{/* View Toggle */}
					{selectedInstanceId && (
						<div className="flex gap-2 p-1 bg-bg-subtle rounded-lg">
							<button
								type="button"
								onClick={() => setBrowseView("formats")}
								className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
									browseView === "formats"
										? "bg-primary text-white"
										: "text-fg-muted hover:text-fg hover:bg-bg"
								}`}
							>
								Individual Formats
							</button>
							<button
								type="button"
								onClick={() => setBrowseView("groups")}
								className={`flex-1 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
									browseView === "groups"
										? "bg-primary text-white"
										: "text-fg-muted hover:text-fg hover:bg-bg"
								}`}
							>
								Format Groups
							</button>
						</div>
					)}

					{/* Only show content when instance is selected */}
					{selectedInstanceId && (
					<div className="flex-1 flex flex-col overflow-hidden space-y-4">
						{browseView === "formats" ? (
							<>
						{/* Search and Select All */}
						<div className="flex gap-3 items-center">
							<Input
								type="text"
								placeholder="Search custom formats..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="flex-1"
							/>
							{!isLoading && !error && filteredFormats.length > 0 && (
								<label className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-bg cursor-pointer hover:bg-bg-subtle transition-colors whitespace-nowrap">
									<input
										type="checkbox"
										checked={selectedFormats.size === filteredFormats.length && filteredFormats.length > 0}
										onChange={toggleSelectAll}
										className="h-4 w-4 rounded border-border bg-bg-subtle text-primary focus:ring-2 focus:ring-primary focus:ring-offset-2"
									/>
									<span className="text-sm text-fg">
										Select All
									</span>
								</label>
							)}
						</div>

						{/* Selection summary */}
						{selectedFormats.size > 0 && (
							<div className="flex items-center justify-between px-3 py-2 rounded-lg border border-primary/30 bg-primary/5">
								<span className="text-sm text-fg">
									{selectedFormats.size} format{selectedFormats.size !== 1 ? 's' : ''} selected
								</span>
								<div className="flex gap-2">
									<Button
										size="sm"
										variant="ghost"
										onClick={() => setSelectedFormats(new Set())}
									>
										Clear Selection
									</Button>
									<Button
										size="sm"
										onClick={handleImportSelected}
									>
										Import Selected ({selectedFormats.size})
									</Button>
								</div>
							</div>
						)}

						{/* Loading state */}
						{isLoading && (
							<div className="flex items-center justify-center py-12">
								<div className="text-fg-muted">Loading TRaSH custom formats...</div>
							</div>
						)}

						{/* Error state */}
						{error && (
							<div className="rounded-lg border border-danger bg-danger/10 px-4 py-3">
								<p className="text-sm text-danger">
									Failed to load TRaSH guides. Please try again later.
								</p>
							</div>
						)}

						{/* Formats list */}
						{!isLoading && !error && (
							<div className="flex-1 overflow-y-auto space-y-2">
								{filteredFormats.length === 0 ? (
									<div className="flex items-center justify-center py-12">
										<p className="text-fg-muted">
											{searchQuery
												? "No custom formats match your search"
												: "No custom formats available"}
										</p>
									</div>
								) : (
									filteredFormats.map((format) => {
										const isSelected = selectedFormats.has(format.trash_id);
										return (
											<div
												key={format.trash_id}
												className={`border rounded-lg p-4 transition-colors ${
													isSelected
														? 'border-primary/50 bg-primary/5'
														: 'border-border bg-bg-subtle/30 hover:border-primary/50'
												}`}
											>
												<div className="flex items-start gap-4">
													{/* Checkbox */}
													<input
														type="checkbox"
														checked={isSelected}
														onChange={() => toggleSelectFormat(format.trash_id)}
														className="mt-1 h-4 w-4 rounded border-border bg-bg-subtle text-primary focus:ring-2 focus:ring-primary focus:ring-offset-2 cursor-pointer"
													/>

													<div className="flex-1 space-y-2">
														<div className="flex items-center gap-2">
															<h3 className="font-medium text-fg">
																{format.name}
															</h3>
															{format.specifications.length > 0 && (
																<Badge variant="secondary" className="text-xs">
																	{format.specifications.length} spec
																	{format.specifications.length !== 1 ? "s" : ""}
																</Badge>
															)}
														</div>
														{format.trash_description && (
															<p className="text-sm text-fg-muted">
																{format.trash_description}
															</p>
														)}
														{format.trash_scores && Object.keys(format.trash_scores).length > 0 && (
															<div className="text-xs text-fg-muted">
																Suggested scores:{" "}
																{Object.entries(format.trash_scores)
																	.slice(0, 3)
																	.map(([profile, score]) => `${profile}: ${score}`)
																	.join(", ")}
																{Object.keys(format.trash_scores).length > 3 && " ..."}
															</div>
														)}
													</div>

													<div className="flex gap-2 shrink-0">
														<Button
															size="sm"
															variant="ghost"
															onClick={() => handleViewDetails(format)}
														>
															View
														</Button>
													</div>
												</div>
											</div>
										);
									})
								)}
							</div>
						)}

						{/* Footer info */}
						{!isLoading && !error && customFormats.length > 0 && (
							<div className="text-sm text-fg-muted border-t border-border pt-3">
								<p>
									Showing {filteredFormats.length} of {customFormats.length} custom
									formats from TRaSH Guides
								</p>
								<p className="text-xs mt-1">
									Source: <a
										href="https://trash-guides.info/"
										target="_blank"
										rel="noopener noreferrer"
										className="text-primary hover:underline"
									>
										trash-guides.info
									</a>
								</p>
							</div>
						)}
							</>
						) : (
							<>
						{/* CF Groups View */}
						{/* Search */}
						<div className="flex gap-3 items-center">
							<Input
								type="text"
								placeholder="Search CF groups..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								className="flex-1"
							/>
						</div>

						{/* Loading state */}
						{isLoading && (
							<div className="flex items-center justify-center py-12">
								<div className="text-fg-muted">Loading TRaSH CF groups...</div>
							</div>
						)}

						{/* Error state */}
						{error && (
							<div className="rounded-lg border border-danger bg-danger/10 px-4 py-3">
								<p className="text-sm text-danger">
									Failed to load TRaSH CF groups. Please try again later.
								</p>
							</div>
						)}

						{/* CF Groups list */}
						{!isLoading && !error && (
							<div className="flex-1 overflow-y-auto space-y-2">
								{filteredGroups.length === 0 ? (
									<div className="flex items-center justify-center py-12">
										<p className="text-fg-muted">
											{searchQuery
												? "No CF groups match your search"
												: "No CF groups available"}
										</p>
									</div>
								) : (
									filteredGroups.map((group) => (
										<div
											key={group.fileName}
											className="border rounded-lg p-4 border-border bg-bg-subtle/30 hover:border-primary/50 transition-colors"
										>
											<div className="flex items-start gap-4">
												<div className="flex-1 space-y-2">
													<div className="flex items-center gap-2">
														<h3 className="font-medium text-fg">
															{group.name}
														</h3>
														{group.custom_formats && group.custom_formats.length > 0 && (
															<Badge variant="secondary" className="text-xs">
																{group.custom_formats.length} format{group.custom_formats.length !== 1 ? "s" : ""}
															</Badge>
														)}
														{group.default && (
															<Badge variant="secondary" className="text-xs bg-success/20 text-success">
																Default
															</Badge>
														)}
													</div>
													{group.trash_description && (
														<p className="text-sm text-fg-muted">
															{group.trash_description}
														</p>
													)}
													{group.custom_formats && group.custom_formats.length > 0 && (
														<div className="text-xs text-fg-muted">
															Includes: {group.custom_formats.slice(0, 3).map(cf => cf.trash_id).join(", ")}
															{group.custom_formats.length > 3 && ` and ${group.custom_formats.length - 3} more...`}
														</div>
													)}
												</div>

												<div className="flex gap-2 shrink-0">
													<Button
														size="sm"
														onClick={() => handleImportGroup(group)}
														disabled={cfGroupImportMutation.isPending}
													>
														Import Group
													</Button>
												</div>
											</div>
										</div>
									))
								)}
							</div>
						)}

						{/* Footer info */}
						{!isLoading && !error && cfGroups.length > 0 && (
							<div className="text-sm text-fg-muted border-t border-border pt-3">
								<p>
									Showing {filteredGroups.length} of {cfGroups.length} CF groups from TRaSH Guides
								</p>
								<p className="text-xs mt-1">
									Source: <a
										href="https://trash-guides.info/"
										target="_blank"
										rel="noopener noreferrer"
										className="text-primary hover:underline"
									>
										trash-guides.info
									</a>
								</p>
							</div>
						)}
							</>
						)}

						{/* Footer actions */}
						<div className="flex gap-2 justify-end border-t border-border pt-4">
							<Button variant="ghost" onClick={onClose}>
								Close
							</Button>
						</div>
					</div>
					)}
				</DialogContent>
			</Dialog>

			{/* Details Modal */}
			{selectedFormat && (
				<Dialog open={true} onOpenChange={handleCloseDetails}>
					<DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
						<DialogHeader>
							<DialogTitle>{selectedFormat.name}</DialogTitle>
							<DialogDescription>
								Custom format details from TRaSH Guides
							</DialogDescription>
						</DialogHeader>

						<div className="flex-1 overflow-y-auto space-y-4">
							{/* Specifications */}
							<div className="space-y-2">
								<h3 className="text-sm font-medium text-fg">
									Specifications ({selectedFormat.specifications.length})
								</h3>
								<div className="space-y-2">
									{selectedFormat.specifications.map((spec, index) => (
										<div
											key={index}
											className="border border-border rounded-lg p-3 bg-bg-subtle/30 space-y-1"
										>
											<div className="flex items-center gap-2">
												<span className="text-sm font-medium text-fg">
													{spec.name}
												</span>
												<Badge variant="secondary" className="text-xs">
													{spec.implementation}
												</Badge>
												{spec.negate && (
													<Badge variant="secondary" className="text-xs bg-warning/20 text-warning">
														Negate
													</Badge>
												)}
												{spec.required && (
													<Badge variant="secondary" className="text-xs bg-danger/20 text-danger">
														Required
													</Badge>
												)}
											</div>
										</div>
									))}
								</div>
							</div>

							{/* Suggested Scores */}
							{selectedFormat.trash_scores && Object.keys(selectedFormat.trash_scores).length > 0 && (
								<div className="space-y-2">
									<h3 className="text-sm font-medium text-fg">Suggested Scores</h3>
									<div className="border border-border rounded-lg p-3 bg-bg-subtle/30">
										<div className="grid grid-cols-2 gap-2 text-sm">
											{Object.entries(selectedFormat.trash_scores).map(([profile, score]) => (
												<div key={profile} className="flex justify-between">
													<span className="text-fg-muted">{profile}:</span>
													<span className="text-fg font-medium">{score}</span>
												</div>
											))}
										</div>
									</div>
								</div>
							)}

							{/* JSON Preview */}
							<div className="space-y-2">
								<h3 className="text-sm font-medium text-fg">JSON</h3>
								<div className="rounded-lg border border-border bg-bg-subtle/30 p-3">
									<pre className="text-xs text-fg-muted overflow-x-auto">
										{JSON.stringify(
											{
												name: selectedFormat.name,
												includeCustomFormatWhenRenaming:
													selectedFormat.includeCustomFormatWhenRenaming,
												specifications: selectedFormat.specifications,
											},
											null,
											2
										)}
									</pre>
								</div>
							</div>
						</div>

						<div className="flex gap-2 justify-end border-t border-border pt-4">
							<Button variant="ghost" onClick={handleCloseDetails}>
								Close
							</Button>
							<Button
								onClick={() => {
									handleCloseDetails();
									handleSelect(selectedFormat);
								}}
							>
								Select This Format
							</Button>
						</div>
					</DialogContent>
				</Dialog>
			)}
		</>
	);
}
