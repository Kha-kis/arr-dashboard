"use client";

import { Loader2 } from "lucide-react";
import { useIncognitoMode } from "../../../../contexts/IncognitoContext";
import { useQuiTorrentFiles } from "../../../../hooks/api/useQui";
import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";
import { getLinuxSavePath } from "../../../../lib/incognito";

// ── Files ─────────────────────────────────────────────────────────────

export const FilesSection: React.FC<{ copy: SeriesTorrentCopy }> = ({ copy }) => {
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
