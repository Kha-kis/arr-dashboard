"use client";

import { useEffect, useState } from "react";
import { Button } from "../../../../components/ui/button";
import { toast } from "../../../../components/ui/toast";
import { useQuiTorrentAction, useQuiTorrentProperties } from "../../../../hooks/api/useQui";
import type { SeriesTorrentCopy } from "../../../../lib/api-client/qui";

// ── Limits & seeding rules ────────────────────────────────────────────

export const LimitsSection: React.FC<{ copy: SeriesTorrentCopy; canAct: boolean }> = ({
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
