"use client";

import { Check, Pencil, RefreshCw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../../components/ui/button";
import { toast } from "../../../../components/ui/toast";
import { useIncognitoMode } from "../../../../contexts/IncognitoContext";
import {
	useQuiAddTrackers,
	useQuiEditTracker,
	useQuiRemoveTrackers,
	useQuiTorrentTrackers,
} from "../../../../hooks/api/useQui";
import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";
import { getLinuxIndexer } from "../../../../lib/incognito";

export const TrackersSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	const [incognito] = useIncognitoMode();
	const [addUrl, setAddUrl] = useState("");
	const [editing, setEditing] = useState<string | null>(null);
	const [editUrl, setEditUrl] = useState("");
	const targetAvailable =
		!copy.quiUnreachable && copy.quiInstanceId !== null && copy.qbitInstanceId !== null;
	const trackersQuery = useQuiTorrentTrackers({
		quiInstanceId: copy.quiInstanceId ?? null,
		qbitInstanceId: copy.qbitInstanceId ?? null,
		hash: copy.infoHash,
		enabled: !copy.quiUnreachable,
	});
	const addMutation = useQuiAddTrackers();
	const removeMutation = useQuiRemoveTrackers();
	const editMutation = useQuiEditTracker();
	const busy =
		addMutation.isPending ||
		removeMutation.isPending ||
		editMutation.isPending ||
		trackersQuery.isFetching;
	const trackers = trackersQuery.data?.trackers;
	const allowChanges =
		targetAvailable && canAct && !busy && !trackersQuery.isError && trackers !== undefined;

	const handleAdd = () => {
		const url = addUrl.trim();
		if (!allowChanges || !url) return;
		addMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				urls: [url],
			},
			{
				onSuccess: () => {
					toast.success("Tracker added");
					setAddUrl("");
				},
				onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to add tracker"),
			},
		);
	};

	const handleRemove = (trackerSelector: string) => {
		if (!allowChanges) return;
		removeMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				trackerSelectors: [trackerSelector],
			},
			{
				onSuccess: () => toast.success("Tracker removed"),
				onError: (err) =>
					toast.error(err instanceof Error ? err.message : "Failed to remove tracker"),
			},
		);
	};

	const handleEditSave = (trackerSelector: string) => {
		const url = editUrl.trim();
		if (!allowChanges || !url) return;
		editMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				trackerSelector,
				newURL: url,
			},
			{
				onSuccess: () => {
					toast.success("Tracker updated");
					setEditing(null);
					setEditUrl("");
				},
				onError: (err) =>
					toast.error(err instanceof Error ? err.message : "Failed to update tracker"),
			},
		);
	};

	const cancelEdit = () => {
		setEditing(null);
		setEditUrl("");
	};

	return (
		<div className="space-y-2 text-[11px]">
			{!targetAvailable ? (
				<div className="text-muted-foreground" role="alert">
					Tracker list unavailable because this qUI copy is unreachable or missing its instance
					address. No tracker changes are enabled.
				</div>
			) : trackersQuery.isLoading ? (
				<div className="text-muted-foreground" role="status">
					Loading trackers…
				</div>
			) : trackersQuery.isError && trackers === undefined ? (
				<div className="space-y-1 text-muted-foreground" role="alert">
					<div>Tracker list unavailable. No tracker changes are enabled.</div>
					<Button size="sm" variant="secondary" onClick={() => void trackersQuery.refetch()}>
						<RefreshCw className="mr-1 h-3 w-3" /> Retry
					</Button>
				</div>
			) : null}
			{!targetAvailable && trackers !== undefined ? (
				<div className="text-amber-300" role="status">
					Showing last-known tracker data. Changes are disabled while this qUI copy is unavailable.
				</div>
			) : null}
			{trackers !== undefined ? (
				<>
					{targetAvailable && trackersQuery.isFetching ? (
						<div className="text-amber-300" role="status">
							Refreshing; showing last-known tracker data. Changes are paused.
						</div>
					) : null}
					{targetAvailable && trackersQuery.isError ? (
						<div className="text-amber-300" role="alert">
							Refresh failed; showing last-known tracker data. Retry before making changes.
							<Button size="sm" variant="secondary" onClick={() => void trackersQuery.refetch()}>
								Retry
							</Button>
						</div>
					) : null}
					{trackers.length === 0 ? (
						<div className="text-muted-foreground italic">No trackers</div>
					) : (
						trackers.map((tracker, index) => {
							const label = incognito ? getLinuxIndexer(tracker.hostname) : tracker.hostname;
							const displayLabel = `${label}${tracker.port ? `:${tracker.port}` : ""}${tracker.tier === null ? "" : ` · tier ${tracker.tier}`}`;
							const selectable = tracker.selectable && tracker.trackerSelector !== null;
							const selector = tracker.trackerSelector;
							const rowKey = selector ?? `unselectable-${index}`;
							return (
								<div key={rowKey} className="space-y-1">
									<div className="flex items-center justify-between gap-2">
										<span className="break-all font-mono text-foreground">{displayLabel}</span>
										<span className="shrink-0 text-muted-foreground">
											{tracker.health} · {tracker.numSeeds} seeds · {tracker.numLeeches} leeches
										</span>
									</div>
									{!selectable ? (
										<>
											<p className="text-amber-300">
												This tracker label is ambiguous or unavailable; inspect qUI before changing
												it.
											</p>
											<div className="flex items-center gap-1.5">
												<button
													type="button"
													aria-label={`Edit tracker ${displayLabel}`}
													disabled
													className="text-muted-foreground disabled:opacity-50"
												>
													<Pencil className="h-3 w-3" />
												</button>
												<button
													type="button"
													aria-label={`Remove tracker ${displayLabel}`}
													disabled
													className="text-muted-foreground disabled:opacity-50"
												>
													<Trash2 className="h-3 w-3" />
												</button>
											</div>
										</>
									) : editing === selector ? (
										<div className="flex items-center gap-1.5">
											<input
												aria-label="Replacement announce URL"
												value={editUrl}
												onChange={(event) => setEditUrl(event.target.value)}
												placeholder="New full announce URL"
												className="flex-1 rounded border border-border/60 bg-card/50 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-foreground/40"
											/>
											<button
												type="button"
												aria-label="Save tracker"
												disabled={!allowChanges || !editUrl.trim()}
												onClick={() => handleEditSave(selector!)}
												className="text-muted-foreground hover:text-green-400 disabled:opacity-50"
											>
												<Check className="h-3.5 w-3.5" />
											</button>
											<button
												type="button"
												aria-label="Cancel edit"
												onClick={cancelEdit}
												className="text-muted-foreground hover:text-foreground"
											>
												<X className="h-3.5 w-3.5" />
											</button>
										</div>
									) : (
										<div className="flex items-center gap-1.5">
											<button
												type="button"
												aria-label={`Edit tracker ${displayLabel}`}
												disabled={!allowChanges || !selectable}
												onClick={() => {
													setEditing(selector);
													setEditUrl("");
												}}
												className="text-muted-foreground hover:text-foreground disabled:opacity-50"
											>
												<Pencil className="h-3 w-3" />
											</button>
											<button
												type="button"
												aria-label={`Remove tracker ${displayLabel}`}
												disabled={!allowChanges || !selectable}
												onClick={() => handleRemove(selector!)}
												className="text-muted-foreground hover:text-red-400 disabled:opacity-50"
											>
												<Trash2 className="h-3 w-3" />
											</button>
										</div>
									)}
								</div>
							);
						})
					)}
				</>
			) : null}
			<div className="flex gap-1.5 pt-1">
				<input
					aria-label="New tracker announce URL"
					type="text"
					value={addUrl}
					onChange={(event) => setAddUrl(event.target.value)}
					placeholder="https://tracker.example/announce"
					className="flex-1 rounded border border-border/60 bg-card/50 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-foreground/40"
				/>
				<Button
					size="sm"
					variant="secondary"
					disabled={!allowChanges || !addUrl.trim()}
					onClick={handleAdd}
				>
					Add
				</Button>
			</div>
		</div>
	);
};
