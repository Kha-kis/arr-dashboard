"use client";

import { useIncognitoMode } from "../../../../contexts/IncognitoContext";
import { useQuiTorrentProperties } from "../../../../hooks/api/useQui";
import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";
import { getLinuxSavePath } from "../../../../lib/incognito";

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

export const StatusSection: React.FC<{ copy: SeriesTorrentCopy }> = ({ copy }) => {
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
