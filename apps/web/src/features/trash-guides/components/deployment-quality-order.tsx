import type { DeploymentPreview, DeploymentQualityOrderEntry } from "@arr/shared";
import { useIncognitoMode } from "../../../lib/incognito";

function QualityOrderList({
	entries,
	groupMembers = false,
}: {
	entries: DeploymentQualityOrderEntry[];
	groupMembers?: boolean;
}) {
	return (
		<ol className="list-decimal space-y-1 ps-5">
			{entries.map((entry, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static preview order can include duplicate labels
				<li key={index}>
					{entry.name}
					{!groupMembers && !entry.allowed ? " (disabled)" : ""}
					{entry.children.length > 0 && <QualityOrderList entries={entry.children} groupMembers />}
				</li>
			))}
		</ol>
	);
}

export function DeploymentQualityOrder({ change }: { change: DeploymentPreview["qualityOrder"] }) {
	const [hidden] = useIncognitoMode();
	if (!change) return null;
	return (
		<section className="space-y-3" aria-label="Quality order changes">
			<h3 className="text-sm font-medium text-foreground">Quality Order Changes</h3>
			{hidden ? (
				<p className="text-sm text-muted-foreground">Quality names hidden in incognito mode.</p>
			) : (
				<>
					<p className="text-sm text-muted-foreground">Highest priority first</p>
					<div className="grid gap-4 rounded-xl border border-border/50 p-3 text-sm sm:grid-cols-2">
						<div className="min-w-0 break-words">
							<h4 className="font-medium">Current</h4>
							{change.cutoffBefore && (
								<p className="text-muted-foreground">Cutoff: {change.cutoffBefore}</p>
							)}
							{change.before.length > 0 ? (
								<QualityOrderList entries={change.before} />
							) : (
								<p>No current profile</p>
							)}
						</div>
						<div className="min-w-0 break-words">
							<h4 className="font-medium">Proposed</h4>
							{change.cutoffAfter && (
								<p className="text-muted-foreground">Cutoff: {change.cutoffAfter}</p>
							)}
							<QualityOrderList entries={change.after} />
						</div>
					</div>
				</>
			)}
		</section>
	);
}
