"use client";

import type { ProwlarrIndexer, ProwlarrIndexerDetails } from "@arr/shared";
import { ExternalLink, Globe, Server } from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getLinuxInstanceName, useIncognitoMode } from "../../../lib/incognito";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { safeOpenUrl } from "../../../lib/utils/url-validation";
import { IndexerRow } from "./indexer-row";

const PROWLARR_COLOR = SERVICE_GRADIENTS.prowlarr.from;

/**
 * Instance Card — Clean Container
 *
 * Minimal chrome. The header is a slim bar with the instance name and
 * count. The body is a tight list of indexer rows with dividers.
 */
export const IndexerInstanceCard = ({
	instanceId,
	instanceName,
	prowlarrUrl,
	indexers,
	onTest,
	onUpdate,
	testingKey,
	isPending,
	expandedKey,
	onToggleDetails,
	searchTerm,
}: {
	instanceId: string;
	instanceName: string;
	prowlarrUrl?: string;
	indexers: ProwlarrIndexer[];
	onTest: (instanceId: string, indexerId: number) => void;
	onUpdate: (
		instanceId: string,
		indexerId: number,
		payload: ProwlarrIndexerDetails,
	) => Promise<ProwlarrIndexerDetails>;
	testingKey: string | null;
	isPending: boolean;
	expandedKey: string | null;
	onToggleDetails: (instanceId: string, indexerId: number) => void;
	searchTerm?: string;
}) => {
	const { gradient: _themeGradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();

	return (
		<article className="rounded-xl border border-border/30 bg-card/15 backdrop-blur-xs overflow-hidden">
			{/* Slim header */}
			<header className="flex items-center justify-between px-4 py-3 border-b border-border/20">
				<div className="flex items-center gap-3">
					<Server className="h-4 w-4 shrink-0" style={{ color: PROWLARR_COLOR }} />
					<h2 className="text-sm font-semibold" style={{ color: PROWLARR_COLOR }}>
						{incognitoMode ? getLinuxInstanceName(instanceName) : instanceName}
					</h2>
					<span className="text-xs text-muted-foreground/50 font-mono">
						{indexers.length} {indexers.length === 1 ? "indexer" : "indexers"}
					</span>
				</div>

				{/* Open in Prowlarr */}
				{prowlarrUrl && (
					<button
						type="button"
						onClick={() => safeOpenUrl(`${prowlarrUrl}/settings/indexers`)}
						className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors hover:opacity-80"
						style={{
							color: `${PROWLARR_COLOR}90`,
						}}
					>
						<ExternalLink className="h-3 w-3" />
						<span className="hidden sm:inline">Prowlarr</span>
					</button>
				)}
			</header>

			{/* Indexer rows */}
			{indexers.length === 0 ? (
				<div className="px-4 py-10 text-center">
					<Globe className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
					<p className="text-xs text-muted-foreground/50">No indexers configured</p>
				</div>
			) : (
				<div className="divide-y divide-border/15">
					{indexers.map((indexer, index) => {
						const key = `${instanceId}:${indexer.id}`;
						return (
							<div
								key={key}
								className="animate-in fade-in"
								style={{
									animationDelay: `${index * 20}ms`,
									animationFillMode: "backwards",
								}}
							>
								<IndexerRow
									indexer={indexer}
									instanceId={instanceId}
									onTest={onTest}
									onUpdate={onUpdate}
									testing={testingKey === key && isPending}
									expanded={expandedKey === key}
									onToggleDetails={() => onToggleDetails(instanceId, indexer.id)}
									searchTerm={searchTerm}
								/>
							</div>
						);
					})}
				</div>
			)}
		</article>
	);
};
