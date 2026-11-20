"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../../../components/ui/button";
import { toast } from "../../../../components/ui/toast";
import {
	useQuiCategories,
	useQuiTagMutationFence,
	useQuiTags,
	useQuiTorrentAction,
} from "../../../../hooks/api/useQui";
import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";
import { quiKeys } from "../../../../lib/query-keys";
import { completeQuiTagObservation, quiTagTargetKey } from "../../../../lib/qui-tag-fence";

// ── Tags & Category ───────────────────────────────────────────────────

export const TagsCategorySection: React.FC<{
	copy: SeriesTorrentCopy;
	canAct: boolean;
	refreshTorrent?: () => Promise<boolean>;
}> = ({ copy, canAct, refreshTorrent }) => {
	const actionMutation = useQuiTorrentAction();
	const inputId = useId();
	const queryClient = useQueryClient();
	const actionInFlight = useRef(false);
	const canRead = !copy.quiUnreachable && copy.quiInstanceId != null && copy.qbitInstanceId != null;
	// Drawer-picker data sources. Categories + tags are tiny lists per
	// instance; 5-min cache. `enabled` matches the canAct gate — no point
	// fetching pickers when qui can't reach this torrent anyway.
	const categoriesQuery = useQuiCategories({
		quiInstanceId: copy.quiInstanceId ?? null,
		qbitInstanceId: copy.qbitInstanceId ?? null,
		enabled: canRead,
	});
	const tagsQuery = useQuiTags({
		quiInstanceId: copy.quiInstanceId ?? null,
		qbitInstanceId: copy.qbitInstanceId ?? null,
		enabled: canRead,
	});
	const allCategories = categoriesQuery.data?.categories ?? [];
	const allTags = tagsQuery.data?.tags ?? [];
	// Chips remain observations, not optimistic mutation results. A setTags
	// request replaces the whole list, so do not derive another replacement
	// from the old copy after ANY attempt until a new target-bound read
	// completes. A lost dashboard response may hide an upstream success.
	const currentTags = copy.tags ?? [];
	const tagTarget = {
		quiInstanceId: copy.quiInstanceId,
		qbitInstanceId: copy.qbitInstanceId,
		hash: copy.infoHash,
	};
	const targetIdentity = quiTagTargetKey(tagTarget);
	const tagFence = useQuiTagMutationFence(tagTarget);
	const awaitingTags = tagFence !== null;
	const pendingTags = tagFence?.status === "pending";
	const automaticallyObserved = useRef<string | null>(null);
	const [refreshingTorrent, setRefreshingTorrent] = useState(false);
	const canEdit = canAct && canRead && !actionMutation.isPending && !pendingTags;
	const canEditTags = canEdit && !awaitingTags;
	const [tagDraft, setTagDraft] = useState<{ target: string; value: string } | null>(null);
	const tagPick = tagDraft?.target === targetIdentity ? tagDraft.value : "";
	const categoryBaseline = copy.category ?? "";
	const [categoryDraft, setCategoryDraft] = useState<{
		target: string;
		baseline: string;
		value: string;
	} | null>(null);
	const categoryValue =
		categoryDraft?.target === targetIdentity && categoryDraft.baseline === categoryBaseline
			? categoryDraft.value
			: categoryBaseline;
	const refreshTorrentReads = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: quiKeys.seriesTorrentsAll }),
			queryClient.invalidateQueries({ queryKey: quiKeys.movieTorrentsAll }),
		]);
	const actionSettled = () => {
		actionInFlight.current = false;
		void refreshTorrentReads();
	};
	const refreshTags = useCallback(
		async (fence = tagFence) => {
			if (fence?.status === "pending") return;
			setRefreshingTorrent(true);
			try {
				// Invalidate other panels without racing an automatic read against
				// this explicit post-attempt observation. The caller validates the
				// successful read's exact qUI/qBit/hash, even if tags are unchanged.
				await Promise.all([
					queryClient.invalidateQueries({
						queryKey: quiKeys.seriesTorrentsAll,
						refetchType: "none",
					}),
					queryClient.invalidateQueries({
						queryKey: quiKeys.movieTorrentsAll,
						refetchType: "none",
					}),
				]);
				if (await refreshTorrent?.()) {
					completeQuiTagObservation(queryClient, targetIdentity, fence);
				}
			} catch {
				// A failed read cannot release the replacement fence.
			} finally {
				setRefreshingTorrent(false);
			}
		},
		[queryClient, refreshTorrent, tagFence, targetIdentity],
	);
	useEffect(() => {
		if (
			!tagFence ||
			pendingTags ||
			actionMutation.isPending ||
			automaticallyObserved.current === tagFence.attemptId
		)
			return;
		automaticallyObserved.current = tagFence.attemptId;
		void refreshTags(tagFence);
	}, [actionMutation.isPending, pendingTags, refreshTags, tagFence]);
	const fireSetTags = (next: string[]) => {
		if (!canEditTags || actionInFlight.current) return;
		actionInFlight.current = true;
		actionMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				action: "setTags",
				payload: { tags: next.join(",") },
			},
			{
				onSuccess: () => {
					setTagDraft(null);
					toast.success("Tags updated");
				},
				onError: () =>
					toast.error("Could not update tags. Refresh torrent data before trying again."),
				onSettled: () => {
					actionInFlight.current = false;
				},
			},
		);
	};
	const addTag = () => {
		if (!canEditTags || actionInFlight.current) return;
		const trimmed = tagPick.trim();
		if (!trimmed || currentTags.includes(trimmed)) return;
		const next = [...currentTags, trimmed];
		fireSetTags(next);
	};
	const removeTag = (tag: string) => {
		const next = currentTags.filter((t) => t !== tag);
		fireSetTags(next);
	};
	const saveCategory = () => {
		if (!canEdit || actionInFlight.current) return;
		actionInFlight.current = true;
		actionMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				action: "setCategory",
				payload: { category: categoryValue },
			},
			{
				onSuccess: () => toast.success("Category updated"),
				onError: () =>
					toast.error("Could not update category. Refresh torrent data before trying again."),
				onSettled: actionSettled,
			},
		);
	};
	return (
		<div className="space-y-3 text-[11px]">
			<div className="space-y-1.5">
				<label htmlFor={`${inputId}-tag`} className="text-muted-foreground">
					Tags
				</label>
				{/* Current tag chips with X-to-remove. Pickering via datalist:
				 * typing surfaces existing instance tags but the operator can
				 * also Enter a brand-new tag. Both create the tag if absent
				 * in qBit (qBit auto-creates on first setTags). */}
				<div className="flex flex-wrap gap-1">
					{currentTags.length === 0 && (
						<span className="italic text-muted-foreground">No tags</span>
					)}
					{currentTags.map((tag) => (
						<span
							key={tag}
							className="inline-flex items-center gap-1 rounded bg-card/60 px-1.5 py-0.5 font-mono text-[10px]"
						>
							{tag}
							<button
								type="button"
								aria-label={`Remove tag ${tag}`}
								disabled={!canEditTags}
								onClick={() => removeTag(tag)}
								className="text-muted-foreground hover:text-red-400 disabled:opacity-50"
							>
								×
							</button>
						</span>
					))}
				</div>
				<div className="flex gap-1.5">
					<input
						id={`${inputId}-tag`}
						type="text"
						list="qui-tag-suggestions"
						value={tagPick}
						disabled={!canEditTags}
						onChange={(e) => setTagDraft({ target: targetIdentity, value: e.target.value })}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								addTag();
							}
						}}
						placeholder="Pick or type a tag"
						className="flex-1 rounded border border-border/60 bg-card/50 px-2 py-1 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-foreground/40"
					/>
					<datalist id="qui-tag-suggestions">
						{allTags
							.filter((t) => !currentTags.includes(t))
							.map((t) => (
								<option key={t} value={t} />
							))}
					</datalist>
					<Button
						size="sm"
						variant="secondary"
						disabled={!canEditTags || !tagPick.trim()}
						onClick={addTag}
					>
						Add
					</Button>
				</div>
				<SuggestionStatus
					kind="tag"
					query={tagsQuery}
					available={canRead}
					empty={allTags.length === 0}
				/>
				{awaitingTags ? (
					<p role="status">
						{tagFence?.status === "acknowledged"
							? "Tag change acknowledged; "
							: "Tag change needs verification; "}
						showing last-known tags until torrent data refreshes.
					</p>
				) : null}
			</div>
			<div className="space-y-1">
				<label htmlFor={`${inputId}-category`} className="text-muted-foreground">
					Category
				</label>
				<div className="flex gap-1.5">
					<input
						id={`${inputId}-category`}
						type="text"
						list="qui-category-suggestions"
						value={categoryValue}
						disabled={!canEdit}
						onChange={(e) =>
							setCategoryDraft({
								target: targetIdentity,
								baseline: categoryBaseline,
								value: e.target.value,
							})
						}
						placeholder="Pick or type a category"
						className="flex-1 rounded border border-border/60 bg-card/50 px-2 py-1 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-foreground/40"
					/>
					<datalist id="qui-category-suggestions">
						<option value="" />
						{allCategories.map((c) => (
							<option key={c.name} value={c.name} />
						))}
					</datalist>
					<Button size="sm" variant="secondary" disabled={!canEdit} onClick={saveCategory}>
						Save
					</Button>
				</div>
				<SuggestionStatus
					kind="category"
					query={categoriesQuery}
					available={canRead}
					empty={allCategories.length === 0}
				/>
			</div>
			{actionMutation.isError || tagFence?.status === "unconfirmed" ? (
				<p role="alert" className="text-destructive">
					The tag or category change was not confirmed.
					{awaitingTags
						? " Displayed tags are last-known; refresh torrent data before trying again."
						: " Review the current torrent data before explicitly trying again."}
				</p>
			) : null}
			{actionMutation.isError || awaitingTags || !canAct ? (
				<Button
					size="sm"
					variant="secondary"
					disabled={refreshingTorrent || actionMutation.isPending || pendingTags}
					onClick={() => {
						void refreshTags();
					}}
				>
					Refresh torrent data
				</Button>
			) : null}
		</div>
	);
};

function SuggestionStatus({
	kind,
	query,
	available,
	empty,
}: {
	kind: "tag" | "category";
	query: {
		data?: unknown;
		isError: boolean;
		isLoading: boolean;
		isFetching: boolean;
		isSuccess: boolean;
		refetch: () => unknown;
	};
	available: boolean;
	empty: boolean;
}) {
	if (!available)
		return (
			<p role="status">
				{kind === "tag" ? "Tag" : "Category"} suggestions are unavailable for this torrent.
			</p>
		);
	if (query.isError)
		return (
			<div role="status">
				<p>
					{query.data !== undefined
						? `Refresh failed; showing last-known ${kind} suggestions.`
						: `${kind === "tag" ? "Tag" : "Category"} suggestions are unavailable.`}
				</p>
				<Button
					size="sm"
					variant="secondary"
					disabled={query.isFetching}
					onClick={() => {
						void query.refetch();
					}}
				>
					Retry {kind} suggestions
				</Button>
			</div>
		);
	if (query.isLoading) return <p role="status">Loading {kind} suggestions…</p>;
	if (query.isSuccess && empty) return <p role="status">No {kind} suggestions</p>;
	return null;
}
