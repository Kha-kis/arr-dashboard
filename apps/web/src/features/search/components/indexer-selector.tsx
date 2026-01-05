"use client";

import type { SearchIndexersResponse } from "@arr/shared";
import { Button } from "../../../components/ui";
import { useIncognitoMode, getLinuxIndexer, getLinuxInstanceName } from "../../../lib/incognito";
import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

interface IndexerSelectorProps {
	/**
	 * Available indexers from all instances
	 */
	indexersData: SearchIndexersResponse;
	/**
	 * Currently selected indexers by instance ID
	 */
	selectedIndexers: Record<string, number[]>;
	/**
	 * Handler for toggling a single indexer
	 */
	onToggleIndexer: (instanceId: string, indexerId: number) => void;
	/**
	 * Handler for toggling all indexers in an instance
	 */
	onToggleAll: (instanceId: string, ids: number[]) => void;
}

/**
 * Component for selecting which indexers to search against
 * Displays indexers grouped by Prowlarr instance with toggle controls
 *
 * @component
 */
export const IndexerSelector = ({
	indexersData,
	selectedIndexers,
	onToggleIndexer,
	onToggleAll,
}: IndexerSelectorProps) => {
	const [incognitoMode] = useIncognitoMode();
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	return (
		<div className="space-y-4">
			{indexersData.instances.map((instance) => {
				const ids = selectedIndexers[instance.instanceId] ?? [];
				const allIds = instance.data.map((indexer) => indexer.id);
				const everySelected = allIds.length > 0 && allIds.every((id) => ids.includes(id));

				return (
					<div
						key={instance.instanceId}
						className="rounded-xl border border-border bg-bg-subtle p-4"
					>
						<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
							<div>
								<p className="text-sm font-semibold text-fg">
									{incognitoMode
										? getLinuxInstanceName(instance.instanceName)
										: instance.instanceName}
								</p>
								<p className="text-xs text-fg-muted">
									{ids.length} of {instance.data.length} indexers selected
								</p>
							</div>
							<Button
								type="button"
								variant="ghost"
								onClick={() => onToggleAll(instance.instanceId, allIds)}
							>
								{everySelected ? "Clear" : "Select all"}
							</Button>
						</div>
						<div className="flex flex-wrap gap-2">
							{instance.data.map((indexer) => {
								const isSelected = ids.includes(indexer.id);
								return (
									<button
										key={indexer.id}
										type="button"
										onClick={() => onToggleIndexer(instance.instanceId, indexer.id)}
										className={`rounded-full border px-3 py-1 text-xs transition ${
											isSelected
												? "text-fg"
												: "border-border bg-transparent text-fg-muted hover:border-primary/40"
										}`}
										style={
											isSelected
												? {
														borderColor: themeGradient.from,
														backgroundColor: themeGradient.fromLight,
													}
												: undefined
										}
									>
										{incognitoMode ? getLinuxIndexer(indexer.name) : indexer.name}
									</button>
								);
							})}
							{instance.data.length === 0 && (
								<span className="text-xs text-fg-muted">
									No indexers configured on this instance.
								</span>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
};
