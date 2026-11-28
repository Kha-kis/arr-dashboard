"use client";

import { Download, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useSabOverview } from "../../sabnzbd/lib/sabnzbd-model";

export function SabnzbdQueueWidget() {
	const query = useSabOverview();
	if (!query.data?.configured) return null;
	const instances = query.data.instances;
	const count = instances.reduce((sum, instance) => sum + instance.queueCount, 0);
	const reachable = instances.filter((instance) => instance.reachable).length;
	const partial = instances.some((instance) => instance.queueCoverage !== "complete");

	return (
		<section
			aria-label="SABnzbd queue"
			className="rounded-xl border border-border/50 bg-card/60 p-5"
		>
			<div className="flex items-start justify-between gap-4">
				<div className="flex items-center gap-3">
					<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
						<Download aria-hidden="true" className="h-5 w-5" />
					</div>
					<div>
						<h2 className="font-semibold">SABnzbd</h2>
						<p className="text-sm text-muted-foreground">
							{query.isError
								? "Queue status unavailable"
								: `${count} active ${count === 1 ? "download" : "downloads"} across ${reachable} of ${instances.length} reachable instances`}
						</p>
						{partial && !query.isError && (
							<p role="status" className="mt-1 text-xs text-muted-foreground">
								Some queue data is incomplete.
							</p>
						)}
					</div>
				</div>
				<Link
					href="/sabnzbd"
					className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
				>
					Open queue <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
				</Link>
			</div>
		</section>
	);
}
