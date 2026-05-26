"use client";

import type { QuiMediaInfo } from "@arr/shared";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { useIncognitoMode } from "../../../../contexts/IncognitoContext";
import { useQuiFileMediaInfo, useQuiTorrentFiles } from "../../../../hooks/api/useQui";
import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";
import { getLinuxSavePath } from "../../../../lib/incognito";

// ── Files ─────────────────────────────────────────────────────────────

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|ts|wmv|mov)$/i;

type ResTier = "2160p" | "1080p" | "720p" | "480p";

/** Resolution tier the release name claims (null when it doesn't say). */
const claimedTier = (name: string | null): ResTier | null => {
	if (!name) return null;
	if (/\b(2160p|4k|uhd)\b/i.test(name)) return "2160p";
	if (/\b1080p\b/i.test(name)) return "1080p";
	if (/\b720p\b/i.test(name)) return "720p";
	if (/\b480p\b/i.test(name)) return "480p";
	return null;
};

/** Nearest standard tier for a pixel width. Width beats height — letterboxing
 * shrinks height, but a 1080p frame is still 1920 wide. */
const widthToTier = (width: number): ResTier | null => {
	if (width <= 0) return null;
	if (width >= 3000) return "2160p";
	if (width >= 1700) return "1080p";
	if (width >= 1100) return "720p";
	return "480p";
};

/** Look up one MediaInfo field by stream kind + field name (case-insensitive). */
const fieldValue = (mi: QuiMediaInfo, kind: string, name: string): string | null => {
	const stream = mi.streams.find((s) => s.kind.toLowerCase() === kind.toLowerCase());
	const field = stream?.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
	return field?.value ?? null;
};

/** MediaInfo formats numbers with spaces ("1 920 pixels") — keep only digits. */
const digitsOf = (v: string | null): number => (v ? Number(v.replace(/\D/g, "")) : 0);

const fmtBytes = (n: number) =>
	n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

export const FilesSection: React.FC<{ copy: SeriesTorrentCopy }> = ({ copy }) => {
	const [incognito] = useIncognitoMode();
	const [openIndex, setOpenIndex] = useState<number | null>(null);
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
	const claimed = claimedTier(copy.name);
	return (
		<div className="space-y-1.5 text-[11px]">
			{files.map((f) => {
				const isVideo = VIDEO_EXT.test(f.name);
				const open = openIndex === f.index;
				return (
					<div key={f.index} className="space-y-1">
						<div className="flex items-center justify-between gap-2">
							<span className="break-all font-mono text-foreground/80">
								{incognito ? getLinuxSavePath(f.name) : f.name}
							</span>
							<div className="flex shrink-0 items-center gap-2">
								<span className="text-muted-foreground">{fmtBytes(f.size)}</span>
								{isVideo && (
									<button
										type="button"
										onClick={() => setOpenIndex(open ? null : f.index)}
										className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
									>
										{open ? "Hide" : "Check quality"}
									</button>
								)}
							</div>
						</div>
						{open && <FileMediaInfo copy={copy} fileIndex={f.index} claimed={claimed} />}
					</div>
				);
			})}
		</div>
	);
};

/**
 * Lazy MediaInfo panel for one file. Fetches qui's MediaInfo report and
 * cross-checks the actual on-disk resolution against the quality the
 * release name claims — catches mislabeled releases the *arr layer trusts.
 */
const FileMediaInfo: React.FC<{
	copy: SeriesTorrentCopy;
	fileIndex: number;
	claimed: ResTier | null;
}> = ({ copy, fileIndex, claimed }) => {
	const query = useQuiFileMediaInfo({
		quiInstanceId: copy.quiInstanceId ?? null,
		qbitInstanceId: copy.qbitInstanceId ?? null,
		hash: copy.infoHash,
		fileIndex,
	});
	if (query.isLoading) {
		return (
			<div className="ml-2 flex items-center gap-2 text-[10px] text-muted-foreground">
				<Loader2 className="h-3 w-3 animate-spin" />
				Analyzing file…
			</div>
		);
	}
	if (query.isError || !query.data) {
		return (
			<div className="ml-2 text-[10px] italic text-muted-foreground">
				MediaInfo unavailable — qui needs local filesystem access to the torrent's files.
			</div>
		);
	}
	const mi = query.data.mediaInfo;
	const width = digitsOf(fieldValue(mi, "Video", "Width"));
	const height = digitsOf(fieldValue(mi, "Video", "Height"));
	const videoCodec = fieldValue(mi, "Video", "Format");
	const audioCodec = fieldValue(mi, "Audio", "Format");
	const audioChannels =
		fieldValue(mi, "Audio", "Channel(s)") ?? fieldValue(mi, "Audio", "Channels");
	const actual = widthToTier(width);
	return (
		<div className="ml-2 space-y-0.5 rounded border border-border/40 bg-card/40 px-2 py-1.5 text-[10px] text-muted-foreground">
			{width > 0 ? (
				<div>
					Resolution:{" "}
					<span className="text-foreground">
						{width}×{height}
						{actual ? ` · ${actual}` : ""}
					</span>
				</div>
			) : (
				<div className="italic">No video stream detected</div>
			)}
			{videoCodec && (
				<div>
					Video codec: <span className="text-foreground">{videoCodec}</span>
				</div>
			)}
			{audioCodec && (
				<div>
					Audio:{" "}
					<span className="text-foreground">
						{audioCodec}
						{audioChannels ? ` · ${audioChannels}` : ""}
					</span>
				</div>
			)}
			{claimed && actual && actual === claimed && (
				<div className="flex items-center gap-1 text-green-300">
					<CheckCircle2 className="h-3 w-3 shrink-0" />
					File matches the claimed {claimed} quality
				</div>
			)}
			{claimed && actual && actual !== claimed && (
				<div className="flex items-center gap-1 text-amber-300">
					<AlertTriangle className="h-3 w-3 shrink-0" />
					Release claims {claimed}, but the file is {actual}
				</div>
			)}
		</div>
	);
};
