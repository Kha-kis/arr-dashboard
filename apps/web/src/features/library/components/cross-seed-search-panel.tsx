"use client";

import type { LibraryItemType } from "@arr/shared";
import { AlertCircle, CheckCircle2, Loader2, Search } from "lucide-react";
import { useState } from "react";
import { GlassmorphicCard } from "../../../components/layout/premium-containers";
import { Button } from "../../../components/ui/button";
import { useTriggerQuiCrossSeedSearch } from "../../../hooks/api/useQui";
import { getLinuxSavePath, useIncognitoMode } from "../../../lib/incognito";

interface Props {
	arrInstanceId: string;
	arrItemId: number;
	itemType: LibraryItemType;
	itemTitle: string;
}

/**
 * Per-item cross-seed search action. Triggers qui's dir-scan webhook
 * scoped to this library item's on-disk path. qui searches configured
 * indexers (Prowlarr/Jackett) for a torrent matching the file's content;
 * on match qui injects the .torrent into qBit pointing at the existing
 * file (no re-download).
 *
 * Prerequisite: the operator must have a dir-scan directory configured
 * in qui whose path covers this item's library location (e.g.,
 * `/data/media/movies`). The first error response surfaces qui's actual
 * status code + message — typically 404 "No matching directory found"
 * when qui isn't set up for the path.
 *
 * After a successful match, arr-dashboard's next inode-backfill sweep
 * (or a manual "Run correlation now" from /qui home) picks up the new
 * (dev, ino) → hash association and the item's correlation badge flips.
 */
export const CrossSeedSearchPanel: React.FC<Props> = ({
	arrInstanceId,
	arrItemId,
	itemType,
	itemTitle,
}) => {
	const [isIncognito] = useIncognitoMode();
	const [lastResult, setLastResult] = useState<
		| { kind: "success"; runId: number; scanRoot: string }
		| { kind: "error"; message: string; status?: number }
		| null
	>(null);
	const mutation = useTriggerQuiCrossSeedSearch();

	const displayTitle = isIncognito ? getLinuxSavePath(itemTitle) : itemTitle;

	const handleClick = async () => {
		setLastResult(null);
		try {
			const result = await mutation.mutateAsync({
				arrInstanceId,
				arrItemId,
				itemType,
			});
			setLastResult({ kind: "success", runId: result.runId, scanRoot: result.scanRoot });
		} catch (err) {
			// Best-effort status extraction from the apiRequest error shape.
			// We don't have typed error access; safest to fall back to the
			// message string and let the user read it. The route relays qui's
			// 404 / 409 messages verbatim so they're already meaningful.
			const message =
				err instanceof Error ? err.message : "Failed to trigger qui cross-seed search";
			const statusMatch = message.match(/\b(4\d\d|5\d\d)\b/);
			setLastResult({
				kind: "error",
				message,
				status: statusMatch ? Number(statusMatch[1]) : undefined,
			});
		}
	};

	return (
		<GlassmorphicCard className="space-y-3 p-4">
			<div className="flex items-start justify-between gap-3">
				<div className="space-y-1">
					<h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
						<Search className="h-4 w-4" />
						Cross-seed via qui
					</h3>
					<p className="text-xs text-muted-foreground">
						Ask qui to search trackers for a torrent of {displayTitle}. On a match, qui attaches the
						torrent to the existing file (no re-download).
					</p>
				</div>
				<Button
					type="button"
					variant="secondary"
					size="sm"
					onClick={handleClick}
					disabled={mutation.isPending}
				>
					{mutation.isPending ? (
						<>
							<Loader2 className="h-3.5 w-3.5 animate-spin" />
							<span className="ml-1.5">Searching</span>
						</>
					) : (
						"Search now"
					)}
				</Button>
			</div>

			{lastResult?.kind === "success" && (
				<div className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs">
					<CheckCircle2 className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-green-500" />
					<div className="space-y-0.5">
						<p className="text-green-200">
							Scan queued in qui (run #{lastResult.runId}). Cross-seed matches will inject
							automatically; correlation refreshes on the next backfill tick.
						</p>
						<p className="text-[10px] text-muted-foreground">
							Scan root: {isIncognito ? getLinuxSavePath(lastResult.scanRoot) : lastResult.scanRoot}
						</p>
					</div>
				</div>
			)}

			{lastResult?.kind === "error" && (
				<div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
					<AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-red-500" />
					<div className="space-y-0.5">
						<p className="text-red-200">{lastResult.message}</p>
						{lastResult.status === 404 && (
							<p className="text-[10px] text-muted-foreground">
								qui needs a Dir-Scan directory configured that covers this item&apos;s library path.
								Set it up under Cross-Seed → Dir-Scan in qui&apos;s UI.
							</p>
						)}
						{lastResult.status === 409 && (
							<p className="text-[10px] text-muted-foreground">
								A scan is already running for this directory. Wait for it to finish and try again.
							</p>
						)}
					</div>
				</div>
			)}
		</GlassmorphicCard>
	);
};
