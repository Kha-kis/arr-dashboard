"use client";

import type { ProwlarrIndexer, ProwlarrIndexerDetails } from "@arr/shared";
import { IndexerRow } from "./indexer-row";
import { useIncognitoMode, getLinuxInstanceName } from "../../../lib/incognito";
import { Server, Globe, Hash } from "lucide-react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

// Use centralized Prowlarr color
const PROWLARR_COLOR = SERVICE_GRADIENTS.prowlarr.from;

/**
 * Premium Instance Card
 *
 * Displays all indexers for a single Prowlarr instance with:
 * - Glassmorphic card design
 * - Prowlarr-branded header
 * - Animated indexer rows
 * - Incognito mode support
 */
export const IndexerInstanceCard = ({
	instanceId,
	instanceName,
	indexers,
	onTest,
	onUpdate,
	testingKey,
	isPending,
	expandedKey,
	onToggleDetails,
}: {
	instanceId: string;
	instanceName: string;
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
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();

	return (
		<article className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs overflow-hidden">
			{/* Header */}
			<header
				className="p-5 border-b border-border/30"
				style={{
					background: `linear-gradient(135deg, ${PROWLARR_COLOR}08, transparent)`,
				}}
			>
				<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
					<div className="flex items-center gap-4">
						<div
							className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${PROWLARR_COLOR}20, ${PROWLARR_COLOR}10)`,
								border: `1px solid ${PROWLARR_COLOR}30`,
							}}
						>
							<Server className="h-6 w-6" style={{ color: PROWLARR_COLOR }} />
						</div>
						<div>
							<h2
								className="text-xl font-bold"
								style={{ color: PROWLARR_COLOR }}
							>
								{incognitoMode ? getLinuxInstanceName(instanceName) : instanceName}
							</h2>
							<div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
								<span className="flex items-center gap-1.5">
									<Globe className="h-3.5 w-3.5" />
									{indexers.length} {indexers.length === 1 ? "indexer" : "indexers"}
								</span>
							</div>
						</div>
					</div>

					{/* Instance ID Badge */}
					<div
						className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-mono"
						style={{
							backgroundColor: `${themeGradient.from}10`,
							border: `1px solid ${themeGradient.from}20`,
							color: themeGradient.from,
						}}
					>
						<Hash className="h-3 w-3" />
						<span>{instanceId.slice(0, 8)}...</span>
					</div>
				</div>
			</header>

			{/* Content */}
			<div className="p-5">
				{indexers.length === 0 ? (
					<div className="rounded-xl border border-dashed border-border/50 bg-card/20 p-8 text-center">
						<Globe className="h-10 w-10 mx-auto mb-3 text-muted-foreground" />
						<p className="text-sm text-muted-foreground">
							No indexers configured on this instance.
						</p>
					</div>
				) : (
					<div className="space-y-3">
						{indexers.map((indexer, index) => {
							const key = `${instanceId}:${indexer.id}`;
							return (
								<div
									key={key}
									className="animate-in fade-in slide-in-from-left-2"
									style={{
										animationDelay: `${index * 30}ms`,
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
									/>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</article>
	);
};
