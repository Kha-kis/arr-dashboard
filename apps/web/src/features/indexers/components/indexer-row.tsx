"use client";

import type { ProwlarrIndexer, ProwlarrIndexerDetails } from "@arr/shared";
import { Button } from "../../../components/ui/button";
import { IndexerDetailsPanel } from "./indexer-details-panel";
import { protocolLabel } from "../lib/indexers-utils";

/**
 * Single indexer row displaying basic info with test and details toggle buttons
 * @param indexer - Indexer object
 * @param instanceId - Prowlarr instance ID
 * @param onTest - Callback to test the indexer
 * @param onUpdate - Callback to update indexer details
 * @param testing - Whether the indexer is currently being tested
 * @param expanded - Whether the details panel is expanded
 * @param onToggleDetails - Callback to toggle details panel
 * @returns React component displaying indexer row
 */
export const IndexerRow = ({
  indexer,
  instanceId,
  onTest,
  onUpdate,
  testing,
  expanded,
  onToggleDetails,
}: {
  indexer: ProwlarrIndexer;
  instanceId: string;
  onTest: (instanceId: string, indexerId: number) => void;
  onUpdate: (
    instanceId: string,
    indexerId: number,
    payload: ProwlarrIndexerDetails,
  ) => Promise<ProwlarrIndexerDetails>;
  testing: boolean;
  expanded: boolean;
  onToggleDetails: () => void;
}) => {
  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-white">{indexer.name}</p>
          <p className="text-xs text-white/50">
            {protocolLabel(indexer.protocol)} · Priority {indexer.priority ?? 0}
          </p>
          <div className="flex flex-wrap gap-3 text-xs text-white/60">
            <span>{indexer.enable ? "Enabled" : "Disabled"}</span>
            {indexer.supportsSearch ? <span>Search</span> : null}
            {indexer.supportsRss ? <span>RSS</span> : null}
            {Array.isArray(indexer.capabilities) &&
            indexer.capabilities.length > 0 ? (
              <span>
                {indexer.capabilities.slice(0, 3).join(", ")}
                {indexer.capabilities.length > 3 ? "…" : ""}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            disabled={testing}
            onClick={() => onTest(instanceId, indexer.id)}
          >
            {testing ? "Testing…" : "Test"}
          </Button>
          <Button variant="ghost" onClick={onToggleDetails}>
            {expanded ? "Hide details" : "View details"}
          </Button>
        </div>
      </div>
      <IndexerDetailsPanel
        instanceId={instanceId}
        indexer={indexer}
        expanded={expanded}
        onUpdate={onUpdate}
      />
    </div>
  );
};
