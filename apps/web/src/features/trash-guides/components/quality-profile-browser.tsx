"use client";

import { useState } from "react";
import { useQualityProfiles, useImportQualityProfile } from "../../../hooks/api/useQualityProfiles";
import { Alert, AlertDescription, EmptyState, Skeleton, Input, Button } from "../../../components/ui";
import { X, Download, Check, FileText, Star, Languages, Gauge } from "lucide-react";
import { createSanitizedHtml } from "../../../lib/sanitize-html";
import type { QualityProfileSummary } from "../../../lib/api-client/trash-guides";
import { htmlToPlainText } from "../lib/description-utils";

interface QualityProfileBrowserProps {
	open: boolean;
	onClose: () => void;
	serviceType: "RADARR" | "SONARR";
}

export const QualityProfileBrowser = ({
	open,
	onClose,
	serviceType,
}: QualityProfileBrowserProps) => {
	const [selectedProfile, setSelectedProfile] = useState<QualityProfileSummary | null>(null);
	const [templateName, setTemplateName] = useState("");
	const [templateDescription, setTemplateDescription] = useState("");

	const { data, isLoading, error } = useQualityProfiles(serviceType);
	const importMutation = useImportQualityProfile();

	const handleImport = async () => {
		if (!selectedProfile || !templateName.trim()) {
			return;
		}

		try {
			await importMutation.mutateAsync({
				serviceType,
				trashId: selectedProfile.trashId,
				templateName: templateName.trim(),
				templateDescription: templateDescription.trim() || undefined,
			});

			// Reset state and close
			setSelectedProfile(null);
			setTemplateName("");
			setTemplateDescription("");
			onClose();
		} catch (error) {
			// Error will be displayed through mutation state
		}
	};

	const handleSelectProfile = (profile: QualityProfileSummary) => {
		setSelectedProfile(profile);
		setTemplateName(profile.name);
		setTemplateDescription(
			profile.description
				? htmlToPlainText(profile.description)
				: `Imported from TRaSH Guides: ${profile.name}`,
		);
	};

	if (!open) return null;

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
			role="dialog"
			aria-modal="true"
			aria-labelledby="quality-profile-browser-title"
		>
			<div className="relative w-full max-w-4xl max-h-[90vh] overflow-hidden rounded-xl border border-border bg-bg-subtle shadow-xl">
				{/* Header */}
				<div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-bg-subtle/95 p-6 backdrop-blur">
					<div>
						<h2 id="quality-profile-browser-title" className="text-xl font-semibold text-fg">
							Browse TRaSH Quality Profiles
						</h2>
						<p className="mt-1 text-sm text-fg-muted">
							Select a quality profile to import as a template for {serviceType}
						</p>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={onClose}
						aria-label="Close dialog"
					>
						<X className="h-5 w-5" />
					</Button>
				</div>

				{/* Content */}
				<div className="overflow-y-auto p-6" style={{ maxHeight: "calc(90vh - 180px)" }}>
					{importMutation.isError && (
						<Alert variant="danger" className="mb-4">
							<AlertDescription>
								{importMutation.error instanceof Error
									? importMutation.error.message
									: "Failed to import quality profile"}
							</AlertDescription>
						</Alert>
					)}

					{importMutation.isSuccess && (
						<Alert variant="success" className="mb-4">
							<AlertDescription>
								Successfully imported quality profile as template!
							</AlertDescription>
						</Alert>
					)}

					{error && (
						<Alert variant="danger">
							<AlertDescription>
								{error instanceof Error ? error.message : "Failed to load quality profiles"}
							</AlertDescription>
						</Alert>
					)}

					{isLoading ? (
						<div className="grid gap-4 md:grid-cols-2">
							<Skeleton className="h-48" />
							<Skeleton className="h-48" />
							<Skeleton className="h-48" />
							<Skeleton className="h-48" />
						</div>
					) : data?.profiles.length === 0 ? (
						<EmptyState
							icon={FileText}
							title="No quality profiles available"
							description="No TRaSH Guides quality profiles found for this service"
						/>
					) : (
						<>
							{!selectedProfile ? (
								<div className="grid gap-4 md:grid-cols-2">
									{data?.profiles.map((profile) => (
										<button
											key={profile.trashId}
											type="button"
											onClick={() => handleSelectProfile(profile)}
											className="group relative rounded-xl border border-border bg-bg-subtle/50 p-6 text-left transition hover:border-primary hover:bg-bg-hover"
										>
											<div className="space-y-3">
												<div className="flex items-start justify-between">
													<h3 className="font-medium text-fg">{profile.name}</h3>
													{profile.scoreSet && (
														<span className="rounded bg-primary/20 px-2 py-1 text-xs text-primary">
															{profile.scoreSet}
														</span>
													)}
												</div>

												{profile.description && (
													<p
														className="text-sm text-fg-muted line-clamp-2"
														dangerouslySetInnerHTML={createSanitizedHtml(profile.description)}
													/>
												)}

												<div className="flex flex-wrap gap-3 text-xs text-fg-muted">
													<span className="inline-flex items-center gap-1">
														<Star className="h-3 w-3" />
														{profile.customFormatCount} formats
													</span>
													<span className="inline-flex items-center gap-1">
														<Gauge className="h-3 w-3" />
														{profile.qualityCount} qualities
													</span>
													{profile.language && (
														<span className="inline-flex items-center gap-1">
															<Languages className="h-3 w-3" />
															{profile.language}
														</span>
													)}
												</div>

												<div className="flex items-center justify-between text-xs">
													<span className="text-fg-muted">Cutoff: {profile.cutoff}</span>
													<span
														className={`rounded px-2 py-1 ${
															profile.upgradeAllowed
																? "bg-green-500/20 text-green-300"
																: "bg-bg-hover text-fg-muted"
														}`}
													>
														{profile.upgradeAllowed ? "Upgrades On" : "Upgrades Off"}
													</span>
												</div>
											</div>
										</button>
									))}
								</div>
							) : (
								<div className="space-y-4">
									<div className="rounded-xl border border-border bg-bg-subtle/50 p-6">
										<div className="mb-4 flex items-center justify-between">
											<div>
												<h3 className="text-lg font-medium text-fg">
													{selectedProfile.name}
												</h3>
												<p className="mt-1 text-sm text-fg-muted">
													{selectedProfile.customFormatCount} Custom Formats •{" "}
													{selectedProfile.qualityCount} Quality Settings
												</p>
											</div>
											<Button
												variant="secondary"
												size="sm"
												onClick={() => setSelectedProfile(null)}
											>
												Change Selection
											</Button>
										</div>

										{selectedProfile.description && (
											<p
												className="text-sm text-fg-muted"
												dangerouslySetInnerHTML={createSanitizedHtml(selectedProfile.description)}
											/>
										)}
									</div>

									<div className="space-y-4">
										<div>
											<label className="mb-2 block text-sm font-medium text-fg">
												Template Name <span className="text-danger">*</span>
											</label>
											<Input
												type="text"
												value={templateName}
												onChange={(e) => setTemplateName(e.target.value)}
												placeholder="Enter template name"
												className="w-full"
											/>
										</div>

										<div>
											<label className="mb-2 block text-sm font-medium text-fg">
												Description (Optional)
											</label>
											<textarea
												value={templateDescription}
												onChange={(e) => setTemplateDescription(e.target.value)}
												placeholder="Enter template description"
												rows={4}
												className="w-full rounded-xl border border-border bg-bg-subtle px-4 py-3 text-sm text-fg placeholder:text-fg-muted/60 transition-all duration-200 hover:border-border/80 hover:bg-bg-subtle/80 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:bg-bg-subtle/80"
											/>
										</div>
									</div>
								</div>
							)}
						</>
					)}
				</div>

				{/* Footer */}
				<div className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-bg-subtle/95 p-6 backdrop-blur">
					<Button variant="secondary" onClick={onClose}>
						Cancel
					</Button>
					{selectedProfile && (
						<Button
							variant="primary"
							onClick={handleImport}
							disabled={!templateName.trim() || importMutation.isPending}
							className="gap-2"
						>
							{importMutation.isPending ? (
								<>
									<div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
									Importing...
								</>
							) : (
								<>
									<Download className="h-4 w-4" />
									Import as Template
								</>
							)}
						</Button>
					)}
				</div>
			</div>
		</div>
	);
};
