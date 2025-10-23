"use client";

import React from "react";
import { Card, CardHeader, CardTitle, CardContent, Badge, Button, Alert } from "../../../components/ui";
import type { DiffPlan } from "@arr/shared";
import { Check, X, AlertTriangle, RefreshCw, Plus, Minus, Edit } from "lucide-react";

interface QualityProfileDiffPreviewProps {
	diffPlan: DiffPlan;
	onApprove?: () => void;
	onCancel?: () => void;
	isApplying?: boolean;
}

export const QualityProfileDiffPreview = React.memo<QualityProfileDiffPreviewProps>(
	function QualityProfileDiffPreview({ diffPlan, onApprove, onCancel, isApplying = false }) {
		const { customFormats, qualityProfile, summary, version } = diffPlan;

		// Show warning if no changes
		if (summary.totalChanges === 0) {
			return (
				<Card>
					<CardContent className="py-12">
						<div className="text-center">
							<Check className="w-12 h-12 text-success mx-auto mb-4" />
							<h3 className="text-lg font-medium text-fg mb-2">No Changes Needed</h3>
							<p className="text-fg-muted mb-6">
								Your instance is already in sync with the selected TRaSH profile.
							</p>
							{onCancel && (
								<Button onClick={onCancel} variant="secondary">
									Close
								</Button>
							)}
						</div>
					</CardContent>
				</Card>
			);
		}

		return (
			<div className="space-y-4">
				{/* Summary Card */}
				<Card>
					<CardHeader>
						<div className="flex items-center justify-between">
							<CardTitle className="text-base">Preview Changes</CardTitle>
							{version && (
								<Badge variant="secondary" className="text-xs font-mono">
									{version.commitSha.slice(0, 7)}
								</Badge>
							)}
						</div>
					</CardHeader>
					<CardContent>
						<div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
							{summary.customFormatsCreated > 0 && (
								<div className="text-center p-3 bg-success/10 border border-success/30 rounded-lg">
									<div className="text-2xl font-bold text-success">{summary.customFormatsCreated}</div>
									<div className="text-xs text-success">CFs to Create</div>
								</div>
							)}
							{summary.customFormatsUpdated > 0 && (
								<div className="text-center p-3 bg-warning/10 border border-warning/30 rounded-lg">
									<div className="text-2xl font-bold text-warning">{summary.customFormatsUpdated}</div>
									<div className="text-xs text-warning">CFs to Update</div>
								</div>
							)}
							{summary.customFormatsDeleted > 0 && (
								<div className="text-center p-3 bg-danger/10 border border-danger/30 rounded-lg">
									<div className="text-2xl font-bold text-danger">{summary.customFormatsDeleted}</div>
									<div className="text-xs text-danger">CFs to Delete</div>
								</div>
							)}
							{summary.scoreChanges > 0 && (
								<div className="text-center p-3 bg-primary/10 border border-primary/30 rounded-lg">
									<div className="text-2xl font-bold text-primary">{summary.scoreChanges}</div>
									<div className="text-xs text-primary">Score Changes</div>
								</div>
							)}
						</div>

						{version?.commitMessage && (
							<Alert variant="info" className="text-sm">
								<AlertTriangle className="h-4 w-4" />
								<div>
									<strong>TRaSH Version:</strong> {version.commitMessage}
								</div>
							</Alert>
						)}
					</CardContent>
				</Card>

				{/* Custom Formats to Create */}
				{customFormats.create.length > 0 && (
					<Card>
						<CardHeader>
							<CardTitle className="text-base flex items-center gap-2">
								<Plus className="w-4 h-4 text-success" />
								Custom Formats to Create ({customFormats.create.length})
							</CardTitle>
						</CardHeader>
						<CardContent>
							<div className="space-y-2">
								{customFormats.create.map((cf) => (
									<div
										key={cf.trashId}
										className="flex items-center justify-between p-3 bg-success/5 border border-success/20 rounded-lg"
									>
										<div>
											<div className="font-medium text-fg">{cf.name}</div>
											<div className="text-xs text-fg-muted">
												{cf.specifications.length} specification{cf.specifications.length !== 1 ? "s" : ""}
											</div>
										</div>
										<Badge variant="secondary" className="text-xs">
											{cf.source === "trash" ? "TRaSH" : "Manual"}
										</Badge>
									</div>
								))}
							</div>
						</CardContent>
					</Card>
				)}

				{/* Custom Formats to Update */}
				{customFormats.update.length > 0 && (
					<Card>
						<CardHeader>
							<CardTitle className="text-base flex items-center gap-2">
								<Edit className="w-4 h-4 text-warning" />
								Custom Formats to Update ({customFormats.update.length})
							</CardTitle>
						</CardHeader>
						<CardContent>
							<div className="space-y-2">
								{customFormats.update.map((cf) => (
									<div
										key={cf.id}
										className="p-3 bg-warning/5 border border-warning/20 rounded-lg"
									>
										<div className="font-medium text-fg mb-2">{cf.name}</div>
										<div className="space-y-1">
											{cf.changes.map((change, idx) => (
												<div key={idx} className="text-xs text-fg-muted flex items-center gap-2">
													<RefreshCw className="w-3 h-3" />
													{change}
												</div>
											))}
										</div>
									</div>
								))}
							</div>
						</CardContent>
					</Card>
				)}

				{/* Custom Formats to Delete */}
				{customFormats.delete.length > 0 && (
					<Card>
						<CardHeader>
							<CardTitle className="text-base flex items-center gap-2">
								<Minus className="w-4 h-4 text-danger" />
								Custom Formats to Delete ({customFormats.delete.length})
							</CardTitle>
						</CardHeader>
						<CardContent>
							<div className="space-y-2">
								{customFormats.delete.map((cf) => (
									<div
										key={cf.id}
										className="flex items-center justify-between p-3 bg-danger/5 border border-danger/20 rounded-lg"
									>
										<div>
											<div className="font-medium text-fg">{cf.name}</div>
											<div className="text-xs text-fg-muted">{cf.reason}</div>
										</div>
										<Badge variant="secondary" className="text-xs">
											{cf.source === "trash" ? "TRaSH" : "Manual"}
										</Badge>
									</div>
								))}
							</div>
						</CardContent>
					</Card>
				)}

				{/* Quality Profile Changes */}
				{qualityProfile.action !== "no_change" && qualityProfile.changes && (
					<Card>
						<CardHeader>
							<CardTitle className="text-base flex items-center gap-2">
								<Edit className="w-4 h-4 text-primary" />
								Quality Profile Changes
							</CardTitle>
						</CardHeader>
						<CardContent>
							<div className="space-y-3">
								{qualityProfile.changes.cutoff && (
									<div className="p-3 bg-bg-subtle border border-border rounded-lg">
										<div className="text-sm font-medium text-fg mb-1">Cutoff Quality</div>
										<div className="text-xs text-fg-muted">
											{qualityProfile.changes.cutoff.old} → {qualityProfile.changes.cutoff.new}
										</div>
									</div>
								)}

								{qualityProfile.changes.minFormatScore && (
									<div className="p-3 bg-bg-subtle border border-border rounded-lg">
										<div className="text-sm font-medium text-fg mb-1">Minimum Format Score</div>
										<div className="text-xs text-fg-muted">
											{qualityProfile.changes.minFormatScore.old} → {qualityProfile.changes.minFormatScore.new}
										</div>
									</div>
								)}

								{qualityProfile.changes.cutoffFormatScore && (
									<div className="p-3 bg-bg-subtle border border-border rounded-lg">
										<div className="text-sm font-medium text-fg mb-1">Cutoff Format Score</div>
										<div className="text-xs text-fg-muted">
											{qualityProfile.changes.cutoffFormatScore.old} →{" "}
											{qualityProfile.changes.cutoffFormatScore.new}
										</div>
									</div>
								)}

								{qualityProfile.changes.scoreChanges && qualityProfile.changes.scoreChanges.length > 0 && (
									<div className="p-3 bg-bg-subtle border border-border rounded-lg">
										<div className="text-sm font-medium text-fg mb-2">
											Score Changes ({qualityProfile.changes.scoreChanges.length})
										</div>
										<div className="space-y-1 max-h-48 overflow-y-auto">
											{qualityProfile.changes.scoreChanges.map((change, idx) => (
												<div key={idx} className="flex items-center justify-between text-xs py-1">
													<span className="text-fg-muted">{change.customFormat}</span>
													<span className="font-mono">
														{change.oldScore} → {change.newScore}
													</span>
												</div>
											))}
										</div>
									</div>
								)}
							</div>
						</CardContent>
					</Card>
				)}

				{/* Action Buttons */}
				<div className="flex items-center justify-end gap-3 pt-4">
					{onCancel && (
						<Button onClick={onCancel} variant="secondary" disabled={isApplying}>
							Cancel
						</Button>
					)}
					{onApprove && (
						<Button onClick={onApprove} variant="primary" disabled={isApplying}>
							{isApplying ? "Applying..." : `Apply ${summary.totalChanges} Change${summary.totalChanges !== 1 ? "s" : ""}`}
						</Button>
					)}
				</div>
			</div>
		);
	}
);
