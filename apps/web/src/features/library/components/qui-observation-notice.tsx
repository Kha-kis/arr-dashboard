"use client";

import type { QuiObservationStatus } from "@arr/shared";
import Link from "next/link";

export function QuiObservationNotice({ status }: { status: QuiObservationStatus }) {
	if (status.status !== "unavailable") return null;
	return (
		<p
			role="status"
			className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
		>
			Torrent status is unavailable until a complete qUI sync. Other Library data is still usable.{" "}
			<Link className="font-medium underline underline-offset-2" href="/qui">
				Check qUI connections
			</Link>
			.
		</p>
	);
}
