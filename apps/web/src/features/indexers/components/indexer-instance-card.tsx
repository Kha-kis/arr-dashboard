"use client";

import type { ProwlarrIndexer, ProwlarrIndexerDetails } from "@arr/shared";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { IndexerRow } from "./indexer-row";

/**
 * Card displaying all indexers for a single Prowlarr instance
 * @param instanceId - Prowlarr instance ID
 * @param instanceName - Prowlarr instance name
 * @param indexers - Array of indexers for this instance
 * @param onTest - Callback to test an indexer
 * @param onUpdate - Callback to update indexer details
 * @param testingKey - Key identifying which indexer is currently being tested
 * @param isPending - Whether a test is pending
 * @param expandedKey - Key identifying which indexer details are expanded
 * @param onToggleDetails - Callback to toggle details for an indexer
 * @returns React component displaying instance card
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
  return (
    <Card className="border-white/10 bg-white/5">
      <CardHeader className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
        <div>
          <CardTitle className="text-xl text-white">{instanceName}</CardTitle>
          <CardDescription>{indexers.length} indexers</CardDescription>
        </div>
        <p className="text-xs text-white/40">ID: {instanceId}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {indexers.length === 0 ? (
          <p className="text-sm text-white/60">
            No indexers configured on this instance.
          </p>
        ) : (
          indexers.map((indexer) => {
            const key = `${instanceId}:${indexer.id}`;
            return (
              <IndexerRow
                key={key}
                indexer={indexer}
                instanceId={instanceId}
                onTest={onTest}
                onUpdate={onUpdate}
                testing={testingKey === key && isPending}
                expanded={expandedKey === key}
                onToggleDetails={() => onToggleDetails(instanceId, indexer.id)}
              />
            );
          })
        )}
      </CardContent>
    </Card>
  );
};
