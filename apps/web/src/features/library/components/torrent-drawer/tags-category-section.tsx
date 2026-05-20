"use client";

import { useState } from "react";
import { Button } from "../../../../components/ui/button";
import { toast } from "../../../../components/ui/toast";
import { useQuiCategories, useQuiTags, useQuiTorrentAction } from "../../../../hooks/api/useQui";
import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";

// ── Tags & Category ───────────────────────────────────────────────────

export const TagsCategorySection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	const actionMutation = useQuiTorrentAction();
	// Drawer-picker data sources. Categories + tags are tiny lists per
	// instance; 5-min cache. `enabled` matches the canAct gate — no point
	// fetching pickers when qui can't reach this torrent anyway.
	const categoriesQuery = useQuiCategories({
		quiInstanceId: copy.quiInstanceId ?? null,
		qbitInstanceId: copy.qbitInstanceId ?? null,
		enabled: !copy.quiUnreachable,
	});
	const tagsQuery = useQuiTags({
		quiInstanceId: copy.quiInstanceId ?? null,
		qbitInstanceId: copy.qbitInstanceId ?? null,
		enabled: !copy.quiUnreachable,
	});
	const allCategories = categoriesQuery.data?.categories ?? [];
	const allTags = tagsQuery.data?.tags ?? [];
	// Selected tags = local edit state, seeded from the torrent's current
	// tags. Chip removal mutates this; the picker adds to it; Save fires
	// setTags with the joined string. The full-replace semantics match
	// qBit's setTags (it overwrites — not additive).
	const [currentTags, setCurrentTags] = useState<string[]>(copy.tags ?? []);
	const [tagPick, setTagPick] = useState("");
	const [categoryValue, setCategoryValue] = useState(copy.category ?? "");
	const fireSetTags = (next: string[]) => {
		if (!canAct) return;
		actionMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				action: "setTags",
				payload: { tags: next.join(",") },
			},
			{
				onSuccess: () => toast.success("Tags updated"),
				onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to set tags"),
			},
		);
	};
	const addTag = () => {
		const trimmed = tagPick.trim();
		if (!trimmed || currentTags.includes(trimmed)) return;
		const next = [...currentTags, trimmed];
		setCurrentTags(next);
		setTagPick("");
		fireSetTags(next);
	};
	const removeTag = (tag: string) => {
		const next = currentTags.filter((t) => t !== tag);
		setCurrentTags(next);
		fireSetTags(next);
	};
	const saveCategory = () => {
		if (!canAct) return;
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
				onError: (err) =>
					toast.error(err instanceof Error ? err.message : "Failed to set category"),
			},
		);
	};
	return (
		<div className="space-y-3 text-[11px]">
			<div className="space-y-1.5">
				<label className="text-muted-foreground">Tags</label>
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
								disabled={!canAct}
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
						type="text"
						list="qui-tag-suggestions"
						value={tagPick}
						onChange={(e) => setTagPick(e.target.value)}
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
						disabled={!canAct || !tagPick.trim()}
						onClick={addTag}
					>
						Add
					</Button>
				</div>
			</div>
			<div className="space-y-1">
				<label className="text-muted-foreground">Category</label>
				<div className="flex gap-1.5">
					<input
						type="text"
						list="qui-category-suggestions"
						value={categoryValue}
						onChange={(e) => setCategoryValue(e.target.value)}
						placeholder="Pick or type a category"
						className="flex-1 rounded border border-border/60 bg-card/50 px-2 py-1 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-foreground/40"
					/>
					<datalist id="qui-category-suggestions">
						<option value="" />
						{allCategories.map((c) => (
							<option key={c.name} value={c.name} />
						))}
					</datalist>
					<Button size="sm" variant="secondary" disabled={!canAct} onClick={saveCategory}>
						Save
					</Button>
				</div>
			</div>
		</div>
	);
};
