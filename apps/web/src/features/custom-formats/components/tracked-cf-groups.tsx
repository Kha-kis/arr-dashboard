"use client";

import { Card, CardHeader, CardTitle, CardContent, Button, Badge } from "../../../components/ui";
import { useTrackedCFGroups, useResyncCFGroup } from "../../../hooks/api/useTrashGuides";
import { toast } from "../../../components/ui/toast";

export function TrackedCFGroups() {
	const { data, isLoading, error } = useTrackedCFGroups();
	const resyncMutation = useResyncCFGroup();

	const trackedGroups = data?.groups || [];

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
							</div>
						</div>
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
		</Card>
	);
}
