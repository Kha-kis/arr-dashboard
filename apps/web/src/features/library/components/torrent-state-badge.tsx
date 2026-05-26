"use client";

import { describeQuiState } from "../lib/qui-display";

interface Props {
	state: string;
	ratio: number;
}

/**
 * Compact pill rendered on library cards summarising qui torrent health
 * at a glance. Designed to fit alongside the existing card header badges,
 * so it uses `shortLabel` (no parentheticals) and a numeric ratio suffix.
 *
 * State + ratio come from `LibraryItem.torrentState`/`torrentRatio` —
 * fields the server stamps on each item from the cached `LibraryCache`
 * column. No per-card polling: the same data is already in the page-level
 * `/library` response, so caller passes the values directly.
 *
 * Cross-seed indicator was previously rendered as a chain icon here, but
 * removed in Phase 2.1: cross-seed presence requires a per-item qui call
 * (`/cross-seed/local-matches`) that we don't cache. The full sibling list
 * remains visible in the deep `TorrentHealthPanel` modal.
 *
 * Vocabulary (label + tone) is sourced from `describeQuiState` so this
 * badge and the modal stay in lockstep.
 */
export const TorrentStateBadge = ({ state, ratio }: Props) => {
	const { shortLabel, tone } = describeQuiState(state);
	const ratioText = Number.isFinite(ratio) ? ratio.toFixed(2) : "—";

	return (
		<span
			className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${tone}`}
			aria-label={`Torrent: ${shortLabel}, ratio ${ratioText}`}
		>
			<span>{shortLabel}</span>
			<span aria-hidden="true">·</span>
			<span className="tabular-nums">{ratioText}×</span>
		</span>
	);
};
