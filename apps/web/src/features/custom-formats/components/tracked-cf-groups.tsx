"use client";

import React from "react";
import { Card, CardHeader, CardTitle, CardContent, Button, Badge, Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../../../components/ui";
import { useTrackedCFGroups, useResyncCFGroup, useUntrackCFGroup } from "../../../hooks/api/useTrashGuides";
import { toast } from "../../../components/ui/toast";
import { ChevronDown, ChevronUp } from "lucide-react";

export const TrackedCFGroups = React.memo(function TrackedCFGroups() {
	const { data, isLoading, error } = useTrackedCFGroups();
	const resyncMutation = useResyncCFGroup();
	const untrackMutation = useUntrackCFGroup();

	const [untrackDialogOpen, setUntrackDialogOpen] = React.useState(false);
	const [untrackTarget, setUntrackTarget] = React.useState<{ instanceId: string; groupFileName: string; groupName: string } | null>(null);
	const [deleteFormats, setDeleteFormats] = React.useState(true);
	const [expandedGroups, setExpandedGroups] = React.useState<Set<string>>(new Set());

	const trackedGroups = data?.groups || [];

	const toggleGroup = (groupId: string) => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(groupId)) {
				next.delete(groupId);
			} else {
				next.add(groupId);
			}
			return next;
		});
	};

	const handleResync = async (instanceId: string, groupFileName: string) => {
		try {
			const result = await resyncMutation.mutateAsync({
				instanceId,
				groupFileName,
			});
			toast.success(`Successfully re-synced ${result.imported} formats from ${result.groupName}`);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to re-sync CF group");
		}
	};

	const handleUntrack = async () => {
		if (!untrackTarget) return;

		try {
			const result = await untrackMutation.mutateAsync({
				instanceId: untrackTarget.instanceId,
				groupFileName: untrackTarget.groupFileName,
				deleteFormats,
			});
			const action = deleteFormats ? "removed" : "converted to individual tracking";
			toast.success(`Successfully ${action} ${result.untracked} formats from ${result.groupName}`);
			setUntrackDialogOpen(false);
			setUntrackTarget(null);
			setDeleteFormats(true); // Reset to default
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Failed to untrack CF group");
		}
	};

	if (isLoading) {
		return (
			<Card>
				<CardContent className="py-12">
					<div className="text-center text-fg-muted">Loading tracked CF groups...</div>
				</CardContent>
			</Card>
		);
	}

	if (error) {
		return (
			<Card>
				<CardContent className="py-12">
					<div className="text-center text-danger">Failed to load tracked CF groups</div>
				</CardContent>
			</Card>
		);
	}

	if (trackedGroups.length === 0) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="text-base">Tracked CF Groups</CardTitle>
				</CardHeader>
				<CardContent className="py-12">
					<div className="text-center text-fg-muted">
						No CF groups tracked yet. Import a CF group to start tracking.
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-base">Tracked CF Groups</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				{trackedGroups.map((group) => (
					<div
						key={group.id}
						className="border rounded-lg p-4 border-border bg-bg-subtle/30 hover:border-primary/50 transition-colors"
					>
						<div className="flex items-start gap-4">
							<div className="flex-1 space-y-2">
								<div className="flex items-center gap-2">
									<h3 className="font-medium text-fg">{group.groupName}</h3>
									<Badge variant="secondary" className="text-xs">
										{group.service}
									</Badge>
									<Badge variant="secondary" className="text-xs">
										{group.importedCount} formats
									</Badge>
									{group.qualityProfileName && (
										<Badge variant="primary" className="text-xs">
											{group.qualityProfileName}
										</Badge>
									)}
								</div>
								<div className="flex gap-4 text-sm text-fg-muted">
									<span>Instance: {group.instanceLabel}</span>
									<span>
										Last synced:{" "}
										{new Date(group.lastSyncedAt).toLocaleDateString(undefined, {
											year: "numeric",
											month: "short",
											day: "numeric",
											hour: "2-digit",
											minute: "2-digit",
										})}
									</span>
								</div>
								<div className="text-xs text-fg-muted">Git ref: {group.gitRef}</div>
							</div>

							<div className="flex gap-2 shrink-0">
								<Button
									size="sm"
									onClick={() => handleResync(group.serviceInstanceId, group.groupFileName)}
									disabled={resyncMutation.isPending}
								>
									Re-sync
								</Button>
								<Button
									size="sm"
									variant="destructive"
									onClick={() => {
										setUntrackTarget({
											instanceId: group.serviceInstanceId,
											groupFileName: group.groupFileName,
											groupName: group.groupName,
										});
										setUntrackDialogOpen(true);
									}}
									disabled={untrackMutation.isPending}
								>
									Untrack
								</Button>
							</div>
						</div>

						{/* Custom Formats List */}
						{group.customFormats && group.customFormats.length > 0 && (
							<div className="mt-3 border-t border-border pt-3">
								<button
									onClick={() => toggleGroup(group.id)}
									className="flex items-center gap-2 text-sm font-medium text-fg hover:text-primary transition-colors w-full"
								>
									{expandedGroups.has(group.id) ? (
										<ChevronUp className="w-4 h-4" />
									) : (
										<ChevronDown className="w-4 h-4" />
									)}
									<span>
										Custom Formats ({group.customFormats.length})
									</span>
								</button>

								{expandedGroups.has(group.id) && (
									<div className="mt-2 space-y-1 pl-6">
										{group.customFormats.map((cf) => (
											<div
												key={cf.id}
												className="text-sm py-1.5 px-2 rounded bg-bg-muted/30 border border-border/50 hover:border-primary/30 transition-colors"
											>
												<div className="font-medium text-fg">{cf.customFormatName}</div>
												<div className="text-xs text-fg-muted">
													ID: {cf.customFormatId} • TRaSH ID: {cf.trashId.substring(0, 8)}...
												</div>
											</div>
										))}
									</div>
								)}
							</div>
						)}
					</div>
				))}

				<div className="text-sm text-fg-muted border-t border-border pt-3">
					<p>
						Showing {trackedGroups.length} tracked CF group{trackedGroups.length !== 1 ? "s" : ""}
					</p>
					<p className="text-xs mt-1">
						Re-sync will update all formats in the group with the latest versions from TRaSH Guides
					</p>
				</div>
			</CardContent>

			{/* Untrack CF Group Confirmation Dialog */}
			<Dialog
				open={untrackDialogOpen}
				onOpenChange={(open) => {
					setUntrackDialogOpen(open);
					if (!open) {
						setDeleteFormats(true); // Reset to default when closing
					}
				}}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Untrack CF Group</DialogTitle>
						<DialogDescription>
							Choose how you want to untrack this CF group:
						</DialogDescription>
					</DialogHeader>
					{untrackTarget && (
						<div className="space-y-4 py-4">
							<div className="rounded-lg bg-bg-subtle p-3">
								<p className="font-medium">CF Group: {untrackTarget.groupName}</p>
								<p className="text-sm text-fg-muted mt-1">
									Contains {trackedGroups.find(g => g.serviceInstanceId === untrackTarget.instanceId && g.groupFileName === untrackTarget.groupFileName)?.importedCount || 0} custom formats
								</p>
							</div>

							<div className="space-y-3">
								<label className="flex items-start space-x-3 cursor-pointer">
									<input
										type="radio"
										checked={deleteFormats}
										onChange={() => setDeleteFormats(true)}
										className="mt-1"
									/>
									<div>
										<div className="font-medium text-fg">Delete formats</div>
										<div className="text-sm text-fg-muted">
											Remove the CF group tracking and delete all associated custom formats from Sonarr/Radarr
										</div>
									</div>
								</label>

								<label className="flex items-start space-x-3 cursor-pointer">
									<input
										type="radio"
										checked={!deleteFormats}
										onChange={() => setDeleteFormats(false)}
										className="mt-1"
									/>
									<div>
										<div className="font-medium text-fg">Keep formats</div>
										<div className="text-sm text-fg-muted">
											Remove the CF group tracking but keep the custom formats as individually tracked
										</div>
									</div>
								</label>
							</div>
						</div>
					)}
					<DialogFooter className="gap-2">
						<Button
							variant="outline"
							onClick={() => {
								setUntrackDialogOpen(false);
								setUntrackTarget(null);
								setDeleteFormats(true); // Reset to default
							}}
						>
							Cancel
						</Button>
						<Button
							variant={deleteFormats ? "destructive" : "primary"}
							onClick={handleUntrack}
							disabled={untrackMutation.isPending}
						>
							{untrackMutation.isPending ? "Processing..." : deleteFormats ? "Delete Formats" : "Keep Formats"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</Card>
	);
});
