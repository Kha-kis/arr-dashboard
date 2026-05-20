"use client";

import {
	AlertTriangle,
	ChevronDown,
	ChevronRight,
	ExternalLink,
	Loader2,
	Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "../../../components/ui/sheet";
import { toast } from "../../../components/ui/toast";
import { useIncognitoMode } from "../../../contexts/IncognitoContext";
import {
	useQuiAddTrackers,
	useQuiCategories,
	useQuiEditTracker,
	useQuiRemoveTrackers,
	useQuiRenameTorrent,
	useQuiTags,
	useQuiTorrentAction,
	useQuiTorrentFiles,
	useQuiTorrentProperties,
} from "../../../hooks/api/useQui";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import type { SeriesTorrentCopy } from "../../../lib/api-client/qui";
import { getLinuxSavePath } from "../../../lib/incognito";

interface TorrentDetailDrawerProps {
	copy: SeriesTorrentCopy | null;
	/**
	 * *arr-side context the drawer was launched from. Surfaces in the
	 * header so the user knows what content this torrent belongs to —
	 * qBit's name field is often unrelated to the *arr item (e.g. a
	 * generic folder name like "distributions"). Cold Read v2 finding.
	 */
	arrContext?: { seriesTitle: string; coverageLabel: string } | null;
	onClose: () => void;
}

/**
 * Per-torrent detail drawer — full control surface for one torrent.
 * Opens as a right-side sheet (480px wide); the user picks a section
 * to expand and the heavy data (properties, files) lazy-loads on demand.
 *
 * Sections are deliberately frequency-ordered: Status + Actions are
 * always open at the top, Danger Zone always last and collapsed. Each
 * intermediate section's collapse default reflects expected usage
 * frequency from the Cold Read survey (2026-05-18): Trackers + Tags
 * default open, Limits/Behavior/Files default closed.
 */
export const TorrentDetailDrawer: React.FC<TorrentDetailDrawerProps> = ({
	copy,
	arrContext,
	onClose,
}) => {
	const open = copy !== null;
	return (
		<Sheet open={open} onOpenChange={(o) => !o && onClose()}>
			<SheetContent side="right" className="w-[480px] sm:max-w-[480px] overflow-y-auto">
				{copy && <DrawerBody copy={copy} arrContext={arrContext ?? null} />}
			</SheetContent>
		</Sheet>
	);
};

const DrawerBody: React.FC<{
	copy: SeriesTorrentCopy;
	arrContext: { seriesTitle: string; coverageLabel: string } | null;
}> = ({ copy, arrContext }) => {
	const [incognito] = useIncognitoMode();
	const canAct =
		!copy.quiUnreachable &&
		typeof copy.qbitInstanceId === "number" &&
		typeof copy.quiInstanceId === "string";

	return (
		<div className="space-y-4 text-[12px]">
			<SheetHeader className="space-y-1">
				{/* *arr-side anchor — surfaces ABOVE the qBit name so the user
				 * recognizes which content this torrent belongs to (Euphoria
				 * S03E01) before reading the often-cryptic qBit name. Cold
				 * Read v2 caught this gap. */}
				{arrContext && (
					<div className="text-[10px] uppercase tracking-wider text-muted-foreground/80">
						From {arrContext.seriesTitle} · {arrContext.coverageLabel}
					</div>
				)}
				<SheetTitle className="break-all font-mono text-[13px] leading-snug">
					{/* `copy.name` is qBit's display name. For library copies
					 * with a folder-style name it can read like a path —
					 * surface the leaf segment so the title isn't dominated
					 * by parent directories. Incognito mask still applies. */}
					{(() => {
						if (!copy.name) return copy.infoHash.slice(0, 12);
						const display = incognito ? getLinuxSavePath(copy.name) : copy.name;
						const leaf = display.includes("/") ? (display.split("/").pop() ?? display) : display;
						return leaf;
					})()}
				</SheetTitle>
				{/* Incognito visibility — when paths/names are masked, surface
				 * a pill so the user can't mistake masked stubs for real
				 * data. Cold Read v2 spent 20 minutes confused about
				 * /media/nas/linux before we realized incognito was on. */}
				{incognito && (
					<div className="text-[10px] italic text-amber-300/80">
						Incognito mode on — names + paths are masked
					</div>
				)}
				<div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
					<span
						className={`rounded px-1.5 py-0.5 ${
							copy.role === "library"
								? "bg-blue-500/20 text-blue-200"
								: "bg-purple-500/20 text-purple-200"
						}`}
					>
						{copy.role === "library" ? "Library" : "Cross-seed"}
					</span>
					<span className="font-mono">{copy.infoHash.slice(0, 12)}…</span>
					{typeof copy.ratio === "number" && <span>ratio {copy.ratio.toFixed(2)}×</span>}
				</div>
			</SheetHeader>

			<StatusSection copy={copy} />
			<ActionsSection copy={copy} canAct={canAct} />

			<DrawerSection title="Trackers" defaultOpen={true}>
				<TrackersSection copy={copy} canAct={canAct} />
			</DrawerSection>

			<DrawerSection title="Tags & Category" defaultOpen={true}>
				<TagsCategorySection copy={copy} canAct={canAct} />
			</DrawerSection>

			<DrawerSection title="Limits & seeding rules" defaultOpen={false}>
				<LimitsSection copy={copy} canAct={canAct} />
			</DrawerSection>

			<DrawerSection title="Behavior" defaultOpen={false}>
				<BehaviorSection copy={copy} canAct={canAct} />
			</DrawerSection>

			<DrawerSection title="Files" defaultOpen={false}>
				<FilesSection copy={copy} />
			</DrawerSection>

			<DrawerSection title="Advanced" defaultOpen={false}>
				<AdvancedSection copy={copy} canAct={canAct} />
			</DrawerSection>

			<DrawerSection title="Danger zone" defaultOpen={false} tone="danger">
				<DangerZoneSection copy={copy} canAct={canAct} />
			</DrawerSection>
		</div>
	);
};

// ── Reusable collapsible section ──────────────────────────────────────

const DrawerSection: React.FC<{
	title: string;
	defaultOpen?: boolean;
	tone?: "default" | "danger";
	children: React.ReactNode;
}> = ({ title, defaultOpen = false, tone = "default", children }) => {
	const [open, setOpen] = useState(defaultOpen);
	return (
		<div
			className={`rounded border ${
				tone === "danger" ? "border-red-500/30 bg-red-500/5" : "border-border/40 bg-card/30"
			}`}
		>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className={`flex w-full items-center justify-between px-3 py-2 text-left text-[11px] font-medium ${
					tone === "danger" ? "text-red-200" : "text-foreground"
				}`}
			>
				<span className="flex items-center gap-1.5">
					{tone === "danger" && <AlertTriangle className="h-3.5 w-3.5" />}
					{title}
				</span>
				{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
			</button>
			{open && <div className="border-t border-border/30 px-3 py-2">{children}</div>}
		</div>
	);
};

// Mirror of friendlyState() in series-torrents-panel.tsx so the drawer's
// Status section shows the same normalized vocabulary as the cluster
// row badge ("Seeding", "Paused", etc.) instead of qBit's raw enum
// (`stalledUP`, `pausedDL`). Kept locally rather than imported because
// the panel file owns the helper alongside its sibling helpers.
const friendlyState = (state: string | null): string | null => {
	if (!state) return null;
	const s = state.toLowerCase();
	if (s.includes("uploading") || s === "seeding" || s === "stalledup") return "Seeding";
	if (s.includes("downloading") || s === "stalleddl") return "Downloading";
	if (s.startsWith("paused")) return "Paused";
	if (s.startsWith("stopped")) return "Stopped";
	if (s.startsWith("checking")) return "Checking";
	if (s.includes("error")) return "Error";
	return state;
};

// ── Status (always open) ──────────────────────────────────────────────

const StatusSection: React.FC<{ copy: SeriesTorrentCopy }> = ({ copy }) => {
	const [incognito] = useIncognitoMode();
	const propsQuery = useQuiTorrentProperties({
		quiInstanceId: copy.quiInstanceId ?? null,
		qbitInstanceId: copy.qbitInstanceId ?? null,
		hash: copy.infoHash,
		enabled: !copy.quiUnreachable,
	});
	const props = propsQuery.data?.properties;
	const fmtBytes = (n: number) => {
		if (n < 1024) return `${n} B`;
		if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
		if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
		return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
	};
	const fmtSpeed = (bps: number) => (bps > 0 ? `${fmtBytes(bps)}/s` : "—");
	return (
		<div className="rounded border border-border/40 bg-card/30 px-3 py-2 text-[11px]">
			<div className="grid grid-cols-2 gap-x-4 gap-y-1">
				<div>
					<span className="text-muted-foreground">State:</span>{" "}
					<span className="text-foreground">
						{friendlyState(copy.state ?? null) ?? copy.state ?? "unknown"}
					</span>
				</div>
				<div>
					<span className="text-muted-foreground">Ratio:</span>{" "}
					<span className="text-foreground">
						{typeof copy.ratio === "number" ? `${copy.ratio.toFixed(2)}×` : "—"}
					</span>
				</div>
				<div>
					<span className="text-muted-foreground">↑ Up:</span>{" "}
					<span className="text-foreground">{props ? fmtSpeed(props.uploadSpeed) : "—"}</span>
				</div>
				<div>
					<span className="text-muted-foreground">↓ Down:</span>{" "}
					<span className="text-foreground">{props ? fmtSpeed(props.downloadSpeed) : "—"}</span>
				</div>
				<div>
					<span className="text-muted-foreground">Size:</span>{" "}
					<span className="text-foreground">{props ? fmtBytes(props.totalSize) : "—"}</span>
				</div>
				<div>
					<span className="text-muted-foreground">Uploaded:</span>{" "}
					<span className="text-foreground">{props ? fmtBytes(props.totalUploaded) : "—"}</span>
				</div>
			</div>
			{copy.savePath && (
				<div className="mt-2 space-y-0.5">
					{/* Label the path explicitly — this is qBit's view of the
					 * location, which in a containerized qBit is the path
					 * INSIDE qBit's filesystem namespace, not the host's.
					 * Cold Read v2 had the user confused that the path
					 * "didn't exist on their system." */}
					<div className="text-[9px] uppercase tracking-wide text-muted-foreground/60">
						qBit save path
					</div>
					<div className="break-all font-mono text-[10px] text-muted-foreground">
						{incognito ? getLinuxSavePath(copy.savePath) : copy.savePath}
					</div>
				</div>
			)}
		</div>
	);
};

// ── Actions (always open) ─────────────────────────────────────────────

const ActionsSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	const actionMutation = useQuiTorrentAction();
	const { data: services } = useServicesQuery();
	const quiOpenUrl = (() => {
		if (!copy.quiInstanceId) return null;
		const inst = services?.find((s) => s.id === copy.quiInstanceId);
		return inst?.externalUrl ?? inst?.baseUrl ?? null;
	})();
	const run = (action: "pause" | "resume" | "recheck" | "reannounce", verb: string) => {
		if (!canAct) return;
		actionMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				action,
				payload: {},
			},
			{
				onSuccess: () =>
					toast.success(`${verb}: ${copy.name ?? copy.infoHash.slice(0, 12)}`, {
						action:
							action === "pause"
								? { label: "Undo", onClick: () => run("resume", "Resumed") }
								: undefined,
					}),
				onError: (err) =>
					toast.error(
						`${verb} failed: ${err instanceof Error ? err.message : "qui rejected the action"}`,
					),
			},
		);
	};
	return (
		<div className="flex flex-wrap gap-1.5">
			<Button
				size="sm"
				variant="secondary"
				disabled={!canAct}
				onClick={() => run("pause", "Paused")}
			>
				Pause
			</Button>
			<Button
				size="sm"
				variant="secondary"
				disabled={!canAct}
				onClick={() => run("resume", "Resumed")}
			>
				Resume
			</Button>
			<Button
				size="sm"
				variant="secondary"
				disabled={!canAct}
				onClick={() => run("recheck", "Rechecked")}
			>
				Recheck
			</Button>
			<Button
				size="sm"
				variant="secondary"
				disabled={!canAct}
				onClick={() => run("reannounce", "Reannounced")}
			>
				Reannounce
			</Button>
			{quiOpenUrl && (
				<Button
					size="sm"
					variant="ghost"
					onClick={() => window.open(quiOpenUrl, "_blank", "noopener,noreferrer")}
				>
					<ExternalLink className="mr-1 h-3 w-3" />
					Open in qui
				</Button>
			)}
		</div>
	);
};

// ── Trackers ──────────────────────────────────────────────────────────

const TrackersSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	const [addUrl, setAddUrl] = useState("");
	const addMutation = useQuiAddTrackers();
	const removeMutation = useQuiRemoveTrackers();
	const _editMutation = useQuiEditTracker();
	void _editMutation;
	const tracks = copy.trackerHostnames ?? [];
	const handleAdd = () => {
		if (!canAct || !addUrl.trim()) return;
		addMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				urls: [addUrl.trim()],
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
	const handleRemove = (url: string) => {
		if (!canAct) return;
		removeMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				urls: [url],
			},
			{
				onSuccess: () => toast.success("Tracker removed"),
				onError: (err) =>
					toast.error(err instanceof Error ? err.message : "Failed to remove tracker"),
			},
		);
	};
	return (
		<div className="space-y-2 text-[11px]">
			{tracks.length === 0 && <div className="text-muted-foreground italic">No trackers</div>}
			{tracks.map((host) => (
				<div key={host} className="flex items-center justify-between gap-2">
					<span className="break-all font-mono text-foreground">{host}</span>
					<button
						type="button"
						aria-label={`Remove tracker ${host}`}
						disabled={!canAct}
						onClick={() => handleRemove(host)}
						className="text-muted-foreground hover:text-red-400 disabled:opacity-50"
					>
						<Trash2 className="h-3 w-3" />
					</button>
				</div>
			))}
			<div className="flex gap-1.5 pt-1">
				<input
					type="text"
					value={addUrl}
					onChange={(e) => setAddUrl(e.target.value)}
					placeholder="https://tracker.example/announce"
					className="flex-1 rounded border border-border/60 bg-card/50 px-2 py-1 text-[11px] focus:outline-none focus:ring-1 focus:ring-foreground/40"
				/>
				<Button
					size="sm"
					variant="secondary"
					disabled={!canAct || !addUrl.trim()}
					onClick={handleAdd}
				>
					Add
				</Button>
			</div>
		</div>
	);
};

// ── Tags & Category ───────────────────────────────────────────────────

const TagsCategorySection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
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

// ── Limits & seeding rules ────────────────────────────────────────────

const LimitsSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	const propsQuery = useQuiTorrentProperties({
		quiInstanceId: copy.quiInstanceId ?? null,
		qbitInstanceId: copy.qbitInstanceId ?? null,
		hash: copy.infoHash,
		enabled: !copy.quiUnreachable,
	});
	const props = propsQuery.data?.properties;
	const actionMutation = useQuiTorrentAction();
	const [up, setUp] = useState<string>(""); // KB/s string for input
	const [down, setDown] = useState<string>("");
	const [ratio, setRatio] = useState<string>("");
	const [seedTime, setSeedTime] = useState<string>(""); // seconds

	// Seed input state from properties WHEN the query resolves. The
	// original implementation used `useState(() => fn)` which only runs
	// once on mount — and at mount time the properties query hasn't
	// resolved yet, so the inputs stayed empty. useEffect runs when
	// `props` transitions from undefined to defined, then noop on
	// subsequent renders as long as the same property object is returned
	// (it's stable across refetches within React Query's cache).
	useEffect(() => {
		if (!props) return;
		// Wire format: uploadLimit/downloadLimit are bytes/sec, with -1 or 0
		// meaning unset/unlimited. Display in KB/sec where positive; blank
		// otherwise. ratioLimit/seedingTimeLimit use qBit's -1/-2 sentinels.
		setUp(props.uploadLimit > 0 ? String(Math.round(props.uploadLimit / 1024)) : "");
		setDown(props.downloadLimit > 0 ? String(Math.round(props.downloadLimit / 1024)) : "");
		setRatio(props.ratioLimit >= 0 ? String(props.ratioLimit) : "");
		setSeedTime(props.seedingTimeLimit >= 0 ? String(props.seedingTimeLimit) : "");
	}, [props]);

	const fire = (
		action: "setUploadLimit" | "setDownloadLimit" | "setShareLimit",
		payload: Record<string, unknown>,
		verb: string,
	) => {
		if (!canAct) return;
		actionMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				action,
				payload,
			},
			{
				onSuccess: () => toast.success(verb),
				onError: (err) => toast.error(err instanceof Error ? err.message : `${verb} failed`),
			},
		);
	};

	// Human-readable description of the current qBit value, used as a
	// "Currently: …" hint next to the input when the value is a sentinel.
	// Blank-when-sentinel reads as "no data" without this — the operator
	// can't tell if the torrent has no override or if the API failed.
	const currentSpeed = (bytesPerSec: number | undefined): string | null => {
		if (bytesPerSec === undefined) return null;
		if (bytesPerSec <= 0) return "unlimited";
		return `${Math.round(bytesPerSec / 1024)} KB/s`;
	};
	const currentShare = (value: number | undefined): string | null => {
		if (value === undefined) return null;
		if (value === -1) return "unlimited";
		if (value === -2) return "use global default";
		return String(value);
	};

	return (
		<div className="space-y-2 text-[11px]">
			<LimitRow
				label="Upload limit (KB/s, 0 = unlimited)"
				value={up}
				current={currentSpeed(props?.uploadLimit)}
				onChange={setUp}
				canAct={canAct}
				onSave={() =>
					fire("setUploadLimit", { uploadLimit: Number(up) * 1024 || 0 }, "Upload limit set")
				}
			/>
			<LimitRow
				label="Download limit (KB/s, 0 = unlimited)"
				value={down}
				current={currentSpeed(props?.downloadLimit)}
				onChange={setDown}
				canAct={canAct}
				onSave={() =>
					fire(
						"setDownloadLimit",
						{ downloadLimit: Number(down) * 1024 || 0 },
						"Download limit set",
					)
				}
			/>
			<LimitRow
				label="Ratio limit (-1 unlimited, -2 use global)"
				value={ratio}
				current={currentShare(props?.ratioLimit)}
				onChange={setRatio}
				canAct={canAct}
				onSave={() =>
					fire(
						"setShareLimit",
						{
							ratioLimit: ratio === "" ? -2 : Number(ratio),
							seedingTimeLimit: seedTime === "" ? -2 : Number(seedTime),
						},
						"Share limit set",
					)
				}
			/>
			<LimitRow
				label="Seed-time limit (minutes, -1 unlimited, -2 global)"
				value={seedTime}
				current={currentShare(props?.seedingTimeLimit)}
				onChange={setSeedTime}
				canAct={canAct}
				onSave={() =>
					fire(
						"setShareLimit",
						{
							ratioLimit: ratio === "" ? -2 : Number(ratio),
							seedingTimeLimit: seedTime === "" ? -2 : Number(seedTime),
						},
						"Share limit set",
					)
				}
			/>
		</div>
	);
};

const LimitRow: React.FC<{
	label: string;
	value: string;
	current: string | null;
	onChange: (s: string) => void;
	canAct: boolean;
	onSave: () => void;
}> = ({ label, value, current, onChange, canAct, onSave }) => (
	<div className="space-y-1">
		<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
			<label className="text-muted-foreground">{label}</label>
			{/* Surface the qBit-reported current value when the input is at
			 * a sentinel ("use global", "unlimited") so a blank input doesn't
			 * read as "no data." Cold Read showed users couldn't tell whether
			 * blank meant "unset" or "we couldn't fetch it." */}
			{current && (
				<span className="text-[10px] italic text-muted-foreground/80">Currently: {current}</span>
			)}
		</div>
		<div className="flex gap-1.5">
			<input
				type="number"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				className="flex-1 rounded border border-border/60 bg-card/50 px-2 py-1 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-foreground/40"
			/>
			<Button size="sm" variant="secondary" disabled={!canAct} onClick={onSave}>
				Save
			</Button>
		</div>
	</div>
);

// ── Behavior ──────────────────────────────────────────────────────────

const BehaviorSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	const actionMutation = useQuiTorrentAction();
	const fire = (
		action: "toggleAutoTMM" | "forceStart",
		payload: Record<string, unknown>,
		verb: string,
	) => {
		if (!canAct) return;
		actionMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				action,
				payload,
			},
			{
				onSuccess: () => toast.success(verb),
				onError: (err) => toast.error(err instanceof Error ? err.message : `${verb} failed`),
			},
		);
	};
	return (
		<div className="space-y-2 text-[11px]">
			<div className="flex flex-wrap gap-1.5">
				<Button
					size="sm"
					variant="secondary"
					disabled={!canAct}
					onClick={() => fire("toggleAutoTMM", { enable: true }, "Auto-management enabled")}
				>
					Enable Auto-management
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={!canAct}
					onClick={() => fire("toggleAutoTMM", { enable: false }, "Auto-management disabled")}
				>
					Disable Auto-management
				</Button>
				<Button
					size="sm"
					variant="secondary"
					disabled={!canAct}
					onClick={() => fire("forceStart", {}, "Force-start toggled")}
				>
					Force start
				</Button>
			</div>
			<div className="text-[10px] italic text-muted-foreground">
				Super-seeding: not supported by qui (qBit-only feature)
			</div>
		</div>
	);
};

// ── Files ─────────────────────────────────────────────────────────────

const FilesSection: React.FC<{ copy: SeriesTorrentCopy }> = ({ copy }) => {
	const [incognito] = useIncognitoMode();
	const filesQuery = useQuiTorrentFiles({
		quiInstanceId: copy.quiInstanceId ?? null,
		qbitInstanceId: copy.qbitInstanceId ?? null,
		hash: copy.infoHash,
		enabled: !copy.quiUnreachable,
	});
	if (filesQuery.isLoading) {
		return (
			<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
				<Loader2 className="h-3 w-3 animate-spin" />
				Loading files…
			</div>
		);
	}
	const files = filesQuery.data?.files ?? [];
	if (files.length === 0)
		return <div className="text-[11px] italic text-muted-foreground">No files</div>;
	const fmtBytes = (n: number) =>
		n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
	return (
		<div className="space-y-1 text-[11px]">
			{files.map((f) => (
				<div key={f.index} className="flex items-center justify-between gap-2">
					<span className="break-all font-mono text-foreground/80">
						{incognito ? getLinuxSavePath(f.name) : f.name}
					</span>
					<span className="shrink-0 text-muted-foreground">{fmtBytes(f.size)}</span>
				</div>
			))}
		</div>
	);
};

// ── Advanced ──────────────────────────────────────────────────────────

const AdvancedSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	const renameMutation = useQuiRenameTorrent();
	const actionMutation = useQuiTorrentAction();
	const [renameValue, setRenameValue] = useState(copy.name ?? "");
	const [locationValue, setLocationValue] = useState(copy.savePath ?? "");
	const handleRename = () => {
		if (!canAct || !renameValue.trim()) return;
		renameMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				name: renameValue.trim(),
			},
			{
				onSuccess: () => toast.success("Renamed"),
				onError: (err) => toast.error(err instanceof Error ? err.message : "Rename failed"),
			},
		);
	};
	const handleSetLocation = () => {
		if (!canAct || !locationValue.trim()) return;
		actionMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				action: "setLocation",
				payload: { location: locationValue.trim() },
			},
			{
				onSuccess: () => toast.success("Location updated — data is being moved by qBit"),
				onError: (err) => toast.error(err instanceof Error ? err.message : "Set location failed"),
			},
		);
	};
	return (
		<div className="space-y-3 text-[11px]">
			<div className="space-y-1">
				<label className="text-muted-foreground">Rename torrent</label>
				<div className="flex gap-1.5">
					<input
						type="text"
						value={renameValue}
						onChange={(e) => setRenameValue(e.target.value)}
						className="flex-1 rounded border border-border/60 bg-card/50 px-2 py-1 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-foreground/40"
					/>
					<Button size="sm" variant="secondary" disabled={!canAct} onClick={handleRename}>
						Rename
					</Button>
				</div>
			</div>
			<div className="space-y-1">
				<label className="text-muted-foreground">Set location (moves data on disk)</label>
				<div className="flex gap-1.5">
					<input
						type="text"
						value={locationValue}
						onChange={(e) => setLocationValue(e.target.value)}
						className="flex-1 rounded border border-border/60 bg-card/50 px-2 py-1 font-mono text-[11px] focus:outline-none focus:ring-1 focus:ring-foreground/40"
					/>
					<Button size="sm" variant="secondary" disabled={!canAct} onClick={handleSetLocation}>
						Move
					</Button>
				</div>
			</div>
		</div>
	);
};

// ── Danger zone ───────────────────────────────────────────────────────

const DangerZoneSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
	copy,
	canAct,
}) => {
	const actionMutation = useQuiTorrentAction();
	const [confirm, setConfirm] = useState<"keep" | "files" | null>(null);
	const handleDelete = (deleteFiles: boolean) => {
		if (!canAct) return;
		actionMutation.mutate(
			{
				quiInstanceId: copy.quiInstanceId!,
				qbitInstanceId: copy.qbitInstanceId!,
				hash: copy.infoHash,
				action: "delete",
				payload: { deleteFiles },
			},
			{
				onSuccess: () => {
					toast.success(deleteFiles ? "Torrent and files deleted" : "Torrent removed (files kept)");
					setConfirm(null);
				},
				onError: (err) => toast.error(err instanceof Error ? err.message : "Delete failed"),
			},
		);
	};
	return (
		<div className="space-y-2 text-[11px]">
			{confirm === null && (
				<div className="flex flex-wrap gap-1.5">
					<Button
						size="sm"
						variant="secondary"
						disabled={!canAct}
						onClick={() => setConfirm("keep")}
					>
						Delete (keep files)
					</Button>
					<Button
						size="sm"
						variant="destructive"
						disabled={!canAct}
						onClick={() => setConfirm("files")}
					>
						Delete with files
					</Button>
				</div>
			)}
			{confirm !== null && (
				<div className="space-y-2 rounded bg-red-500/10 p-2">
					<div className="text-red-200">
						{confirm === "files"
							? "This will delete the torrent AND all files on disk. Cannot be undone."
							: "This will remove the torrent from qBit. Files on disk are kept."}
					</div>
					<div className="flex gap-1.5">
						<Button
							size="sm"
							variant="destructive"
							disabled={!canAct}
							onClick={() => handleDelete(confirm === "files")}
						>
							Yes, delete{confirm === "files" ? " everything" : ""}
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
							Cancel
						</Button>
					</div>
				</div>
			)}
		</div>
	);
};
