import type { QuiTorrent } from "@arr/shared";

export interface QuiStateDescriptor {
	/** Human label — used as-is in deep panels; badges may pick the short form via `shortLabel`. */
	label: string;
	/** Terse label for tight badge contexts where parentheticals don't fit. */
	shortLabel: string;
	/** Tailwind classes for the pill (border + bg + text). */
	tone: string;
}

/**
 * Single source of truth for qui torrent-state vocabulary.
 *
 * Bilingual by design — accepts BOTH:
 *   - Raw qBit states (`uploading`, `stalledUP`, `metaDL`, …) — the deep
 *     `TorrentHealthPanel` modal fetches live qui data via the per-item
 *     endpoint and gets qBit's native state strings.
 *   - Normalized arr-dashboard states (`seeding`, `downloading`, `stalled_dl`,
 *     …) — the per-card `<TorrentStateBadge>` reads these from
 *     `LibraryItem.torrentState` (a normalized column populated by the
 *     periodic qui sync via `normalizeTorrentState`). Phase 2.1 introduced
 *     this normalized vocabulary; the badge consumes it directly without
 *     round-tripping through qBit's own state strings.
 *
 * Both vocabularies map to the same descriptor so users never see two
 * different words for the same underlying state across surfaces.
 *
 * Width-constrained surfaces use `shortLabel`, detail surfaces use `label`.
 */
export const describeQuiState = (state: QuiTorrent["state"] | string): QuiStateDescriptor => {
	switch (state) {
		// Normalized vocabulary (Phase 2.1) — what `LibraryItem.torrentState` stores.
		case "seeding":
			return {
				label: "Seeding",
				shortLabel: "Seeding",
				tone: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
			};
		case "downloading":
			return {
				label: "Downloading",
				shortLabel: "Downloading",
				tone: "bg-sky-500/15 text-sky-300 border-sky-500/30",
			};
		case "stalled_dl":
			return {
				label: "Downloading (stalled)",
				shortLabel: "Stalled DL",
				tone: "bg-amber-500/15 text-amber-300 border-amber-500/30",
			};
		case "paused":
			return {
				label: "Paused",
				shortLabel: "Paused",
				tone: "bg-slate-500/15 text-slate-300 border-slate-500/30",
			};
		case "queued":
			return {
				label: "Queued",
				shortLabel: "Queued",
				tone: "bg-slate-500/15 text-slate-300 border-slate-500/30",
			};
		case "checking":
			return {
				label: "Checking",
				shortLabel: "Checking",
				tone: "bg-violet-500/15 text-violet-300 border-violet-500/30",
			};

		// Raw qBit vocabulary — what the modal's per-item endpoint returns.
		case "uploading":
		case "forcedUP":
			return {
				label: "Seeding",
				shortLabel: "Seeding",
				tone: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
			};
		case "stalledUP":
			return {
				label: "Seeding (idle)",
				shortLabel: "Seeding",
				tone: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
			};
		case "forcedDL":
		case "metaDL":
			return {
				label: "Downloading",
				shortLabel: "Downloading",
				tone: "bg-sky-500/15 text-sky-300 border-sky-500/30",
			};
		case "stalledDL":
			return {
				label: "Downloading (stalled)",
				shortLabel: "Stalled DL",
				tone: "bg-amber-500/15 text-amber-300 border-amber-500/30",
			};
		case "pausedUP":
		case "pausedDL":
			return {
				label: "Paused",
				shortLabel: "Paused",
				tone: "bg-slate-500/15 text-slate-300 border-slate-500/30",
			};
		case "queuedUP":
		case "queuedDL":
			return {
				label: "Queued",
				shortLabel: "Queued",
				tone: "bg-slate-500/15 text-slate-300 border-slate-500/30",
			};
		case "checkingUP":
		case "checkingDL":
			return {
				label: "Checking",
				shortLabel: "Checking",
				tone: "bg-violet-500/15 text-violet-300 border-violet-500/30",
			};

		// Direction-agnostic states (same vocabulary in both raw + normalized).
		case "moving":
			return {
				label: "Moving",
				shortLabel: "Moving",
				tone: "bg-violet-500/15 text-violet-300 border-violet-500/30",
			};
		case "error":
		case "missingFiles":
			return {
				label: "Error",
				shortLabel: "Error",
				tone: "bg-rose-500/15 text-rose-300 border-rose-500/30",
			};

		case "unknown":
		default:
			return {
				label: "Unknown",
				shortLabel: "Unknown",
				tone: "bg-slate-500/15 text-slate-300 border-slate-500/30",
			};
	}
};
