"use client";

import { useEffect, useMemo, useState } from "react";
import type { ProwlarrIndexer, ProwlarrIndexerDetails, ProwlarrIndexerField } from "@arr/shared";
import {
    useSearchIndexersQuery,
  useTestIndexerMutation,
  useIndexerDetailsQuery,
  useUpdateIndexerMutation,
} from "../../../hooks/api/useSearch";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/card";
import { cn } from "../../../lib/utils";

const numberFormatter = new Intl.NumberFormat();
const percentFormatter = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });

const computeStats = (indexers: ProwlarrIndexer[]) => {
  const enabled = indexers.filter((indexer) => indexer.enable);
  const torrent = enabled.filter((indexer) => indexer.protocol === "torrent");
  const usenet = enabled.filter((indexer) => indexer.protocol === "usenet");
  return {
    total: indexers.length,
    enabled: enabled.length,
    disabled: indexers.length - enabled.length,
    torrent: torrent.length,
    usenet: usenet.length,
    search: enabled.filter((indexer) => indexer.supportsSearch).length,
    rss: enabled.filter((indexer) => indexer.supportsRss).length,
  };
};

const protocolLabel = (protocol: ProwlarrIndexer["protocol"]) => {
  switch (protocol) {
    case "torrent":
      return "Torrent";
    case "usenet":
      return "Usenet";
    default:
      return "Unknown";
  }
};

const isApiKeyRelatedField = (field: ProwlarrIndexerField): boolean => {
  const name = (field.name ?? "").toLowerCase();
  const label = (field.label ?? "").toLowerCase();

  if (name.includes("apikey") || name.includes("api_key")) {
    return true;
  }

  if (label.includes("api key")) {
    return true;
  }

  if ((name.includes("about") && name.includes("api")) || (label.includes("about") && label.includes("api"))) {
    return true;
  }

  return false;
};

const formatFieldValue = (name: string, value: unknown) => {

  if (value === null || typeof value === "undefined") {

    return "Not configured";

  }



  if (typeof value === "boolean") {

    return value ? "Enabled" : "Disabled";

  }



  if (Array.isArray(value)) {

    return value

      .map((entry) => (typeof entry === "string" ? entry : typeof entry === "number" ? entry.toString() : undefined))

      .filter(Boolean)

      .join(", ");

  }



  if (typeof value === "object") {

    return Object.values(value as Record<string, unknown>)

      .map((entry) => (typeof entry === "string" || typeof entry === "number" ? entry.toString() : undefined))

      .filter(Boolean)

      .join(", ");

  }



  return String(value);

};

const formatSuccessRate = (value?: number) => {
  if (typeof value !== "number") {
    return "–";
  }
  const normalized = value > 1 ? value / 100 : value;
  return percentFormatter.format(Math.max(0, Math.min(1, normalized)));
};

const formatResponseTime = (value?: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "–";
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(2)} s`;
  }
  return `${Math.round(value)} ms`;
};

const formatDateTime = (value?: string) => {
  if (!value) {
    return "–";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
};

const DetailStat = ({ label, value }: { label: string; value?: string }) => {
  if (!value || value.trim().length === 0) {
    return null;
  }
  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-wider text-white/40">{label}</p>
      <p className="text-sm font-medium text-white">{value}</p>
    </div>
  );
};


const IndexerDetailsPanel = ({
  instanceId,
  indexer,
  expanded,
  onUpdate,
}: {
  instanceId: string;
  indexer: ProwlarrIndexer;
  expanded: boolean;
  onUpdate: (instanceId: string, indexerId: number, payload: ProwlarrIndexerDetails) => Promise<ProwlarrIndexerDetails>;
}) => {
  const { data, isLoading, error, refetch, isFetching } = useIndexerDetailsQuery(
    expanded ? instanceId : null,
    expanded ? indexer.id : null,
    expanded,
  );

  const detail = data ?? {
    id: indexer.id,
    name: indexer.name,
    instanceId,
    instanceName: indexer.instanceName ?? indexer.instanceId ?? "",
    instanceUrl: indexer.instanceUrl,
    enable: indexer.enable,
    priority: indexer.priority,
    tags: indexer.tags,
    protocol: indexer.protocol,
    capabilities: indexer.capabilities,
  };

  const initialEnable = detail.enable ?? indexer.enable ?? false;
  const initialPriority = detail.priority ?? indexer.priority ?? 0;

  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [formEnable, setFormEnable] = useState(initialEnable);
  const [formPriority, setFormPriority] = useState<number | undefined>(initialPriority ?? undefined);

  useEffect(() => {
    if (!expanded) {
      setIsEditing(false);
      setLocalError(null);
      setFormEnable(initialEnable);
      setFormPriority(initialPriority ?? undefined);
      return;
    }

    setFormEnable(initialEnable);
    setFormPriority(initialPriority ?? undefined);
    setLocalError(null);
  }, [expanded, initialEnable, initialPriority]);

  if (!expanded) {
    return null;
  }

  const stats = detail.stats;
  const capabilities = detail.capabilities ?? indexer.capabilities ?? [];
  const categories = detail.categories ?? [];
  const fields = (detail.fields ?? []).filter((field) => !isApiKeyRelatedField(field));

  const detailError = error instanceof Error ? error.message : error ? "Unable to load indexer settings." : null;
  const isLoadingState = isLoading && !detail.fields && !stats;

  const handleStartEditing = () => {
    setFormEnable(initialEnable);
    setFormPriority(initialPriority ?? undefined);
    setIsEditing(true);
    setLocalError(null);
  };

  const handleCancelEditing = () => {
    setFormEnable(initialEnable);
    setFormPriority(initialPriority ?? undefined);
    setIsEditing(false);
    setLocalError(null);
  };

  const handleSaveChanges = async () => {
    setIsSaving(true);
    setLocalError(null);

    const payload: ProwlarrIndexerDetails = {
      ...detail,
      id: detail.id ?? indexer.id,
      instanceId: detail.instanceId ?? instanceId,
      instanceName: detail.instanceName ?? indexer.instanceName ?? "",
      instanceUrl: detail.instanceUrl ?? indexer.instanceUrl,
      enable: formEnable,
      priority: formPriority ?? detail.priority ?? undefined,
      fields: detail.fields ?? [],
    };

    try {
      await onUpdate(instanceId, indexer.id, payload);
      setIsEditing(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update indexer";
      setLocalError(message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6 rounded-lg border border-white/10 bg-slate-950/80 p-4">
      {isLoadingState ? (
        <div className="flex items-center gap-2 text-sm text-white/60">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          Loading indexer settings�
        </div>
      ) : detailError ? (
        <div className="flex flex-col gap-3 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
          <span>{detailError}</span>
          <div>
            <Button variant="ghost" onClick={() => void refetch()} disabled={isFetching}>
              {isFetching ? "Retrying�" : "Retry"}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="grid flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <DetailStat label="Implementation" value={detail.implementationName ?? "Unknown"} />
              <DetailStat label="Protocol" value={protocolLabel(detail.protocol ?? indexer.protocol)} />
              <DetailStat
                label="Priority"
                value={typeof detail.priority === "number" ? detail.priority.toString() : detail.priority === 0 ? "0" : undefined}
              />
              <DetailStat
                label="App profile"
                value={typeof detail.appProfileId === "number" ? detail.appProfileId.toString() : "Default"}
              />
              <DetailStat label="Privacy" value={detail.privacy ?? undefined} />
              <DetailStat label="Language" value={detail.language ?? undefined} />
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:items-end">
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="ghost" onClick={() => void refetch()} disabled={isFetching}>
                  {isFetching ? "Refreshing�" : "Refresh details"}
                </Button>
                {isEditing ? (
                  <>
                    <Button variant="ghost" onClick={handleCancelEditing} disabled={isSaving}>
                      Cancel
                    </Button>
                    <Button onClick={handleSaveChanges} disabled={isSaving}>
                      {isSaving ? "Saving�" : "Save changes"}
                    </Button>
                  </>
                ) : (
                  <Button variant="secondary" onClick={handleStartEditing}>
                    Edit
                  </Button>
                )}
              </div>
              {localError ? <p className="text-sm text-red-300">{localError}</p> : null}
            </div>
          </div>

          {isEditing ? (
            <div className="flex flex-wrap items-center gap-4 text-sm text-white">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-white/20 bg-slate-900"
                  checked={formEnable}
                  onChange={(event) => setFormEnable(event.target.checked)}
                />
                <span>{formEnable ? "Enabled" : "Disabled"}</span>
              </label>
              <div className="flex items-center gap-2">
                <span className="text-xs uppercase tracking-widest text-white/40">Priority</span>
                <Input
                  type="number"
                  value={formPriority === undefined ? "" : formPriority.toString()}
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw.trim().length === 0) {
                      setFormPriority(undefined);
                      return;
                    }
                    const parsed = Number(raw);
                    if (!Number.isNaN(parsed)) {
                      setFormPriority(parsed);
                    }
                  }}
                  className="h-8 w-24 bg-slate-900 text-white"
                />
              </div>
            </div>
          ) : (
            <p className="text-xs text-white/40">
              Advanced configuration remains read-only here. Use the Prowlarr interface for additional changes.
            </p>
          )}

          {stats ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <DetailStat label="Success rate" value={formatSuccessRate(stats.successRate)} />
              <DetailStat label="Average response" value={formatResponseTime(stats.averageResponseTime)} />
              <DetailStat label="Last check" value={formatDateTime(stats.lastCheck)} />
              <DetailStat label="Last failure" value={formatDateTime(stats.lastFailure)} />
            </div>
          ) : null}

          {capabilities.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-widest text-white/40">Capabilities</p>
              <div className="flex flex-wrap gap-2">
                {capabilities.map((capability) => (
                  <span key={capability} className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/70">
                    {capability}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {categories.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-widest text-white/40">Categories</p>
              <div className="flex flex-wrap gap-2">
                {categories.map((category) => (
                  <span key={category} className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/70">
                    {category}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {fields.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs uppercase tracking-widest text-white/40">Configuration</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {fields.slice(0, 10).map((field) => (
                  <div key={field.name} className="rounded-lg border border-white/10 bg-white/5 p-3">
                    <p className="text-xs uppercase text-white/40">{field.label ?? field.name}</p>
                    <p className="mt-1 text-sm text-white">{formatFieldValue(field.name, field.value)}</p>
                    {field.helpText ? (
                      <p className="mt-1 text-xs text-white/40">{field.helpText}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
};

const IndexerRow = ({
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
  onUpdate: (instanceId: string, indexerId: number, payload: ProwlarrIndexerDetails) => Promise<ProwlarrIndexerDetails>;
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
            {Array.isArray(indexer.capabilities) && indexer.capabilities.length > 0 ? (
              <span>
                {indexer.capabilities.slice(0, 3).join(", ")}
                {indexer.capabilities.length > 3 ? "…" : ""}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" disabled={testing} onClick={() => onTest(instanceId, indexer.id)}>
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

export const IndexersClient = () => {
  const { data, isLoading, error, refetch, isFetching } = useSearchIndexersQuery();
  const testMutation = useTestIndexerMutation();
  const updateMutation = useUpdateIndexerMutation();
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const aggregated = useMemo(() => data?.aggregated ?? [], [data?.aggregated]);
  const stats = useMemo(() => computeStats(aggregated), [aggregated]);
  const instances = useMemo(() => data?.instances ?? [], [data?.instances]);
  const noInstances = !isLoading && instances.length === 0;

  const handleTest = async (instanceId: string, indexerId: number) => {
    if (testMutation.isPending) {
      return;
    }
    const key = `${instanceId}:${indexerId}`;
    setTestingKey(key);
    setFeedback(null);
    try {
      const result = await testMutation.mutateAsync({ instanceId, indexerId });
      setFeedback({ type: "success", message: result.message ?? "Indexer test passed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Indexer test failed";
      setFeedback({ type: "error", message });
    } finally {
      setTestingKey(null);
    }
  };

  const handleUpdate = async (updateInstanceId: string, indexerId: number, payload: ProwlarrIndexerDetails) => {
    setFeedback(null);
    try {
      const result = await updateMutation.mutateAsync({ instanceId: updateInstanceId, indexerId, indexer: payload });
      setFeedback({ type: "success", message: "Indexer changes saved" });
      void refetch();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update indexer";
      setFeedback({ type: "error", message });
      throw (err instanceof Error ? err : new Error(message));
    }
  };

  const handleToggleDetails = (instanceId: string, indexerId: number) => {
    const key = `${instanceId}:${indexerId}`;
    setExpandedKey((previous) => (previous === key ? null : key));
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
      </div>
    );
  }

  return (
    <section className="flex flex-col gap-10">
      <header className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-sm font-medium uppercase text-white/60">Indexer management</p>
          <h1 className="text-3xl font-semibold text-white">Indexers</h1>
          <p className="mt-2 text-sm text-white/60">
            Review indexers from your configured Prowlarr instances, inspect their settings, and run connectivity tests.
          </p>
        </div>
        <Button variant="ghost" onClick={() => void refetch()} disabled={isFetching}>
          {isFetching ? "Refreshing…" : "Refresh"}
        </Button>
      </header>

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          Unable to load indexers. Double-check your Prowlarr settings and try again.
        </div>
      )}

      {feedback && (
        <div
          className={cn(
            "rounded-lg border px-4 py-3 text-sm",
            feedback.type === "success"
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/40 bg-red-500/10 text-red-200",
          )}
        >
          {feedback.message}
        </div>
      )}

      {noInstances ? (
        <Card className="border-dashed border-white/20 bg-white/5">
          <CardHeader>
            <CardTitle className="text-xl">No Prowlarr instances configured</CardTitle>
            <CardDescription>
              Add a Prowlarr service in Settings to manage indexers from this dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-white/70">
              Once a Prowlarr instance is enabled, its indexers will appear here automatically.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="border-white/10 bg-white/5">
              <CardHeader className="pb-2">
                <CardDescription>Total indexers</CardDescription>
                <CardTitle className="text-2xl text-white">{numberFormatter.format(stats.total)}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-white/10 bg-white/5">
              <CardHeader className="pb-2">
                <CardDescription>Enabled</CardDescription>
                <CardTitle className="text-2xl text-white">{numberFormatter.format(stats.enabled)}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-white/10 bg-white/5">
              <CardHeader className="pb-2">
                <CardDescription>Torrent</CardDescription>
                <CardTitle className="text-2xl text-white">{numberFormatter.format(stats.torrent)}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-white/10 bg-white/5">
              <CardHeader className="pb-2">
                <CardDescription>Usenet</CardDescription>
                <CardTitle className="text-2xl text-white">{numberFormatter.format(stats.usenet)}</CardTitle>
              </CardHeader>
            </Card>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Card className="border-white/10 bg-white/5">
              <CardHeader className="pb-2">
                <CardDescription>Search capable</CardDescription>
                <CardTitle className="text-2xl text-white">{numberFormatter.format(stats.search)}</CardTitle>
              </CardHeader>
            </Card>
            <Card className="border-white/10 bg-white/5">
              <CardHeader className="pb-2">
                <CardDescription>RSS capable</CardDescription>
                <CardTitle className="text-2xl text-white">{numberFormatter.format(stats.rss)}</CardTitle>
              </CardHeader>
            </Card>
          </div>

          <div className="space-y-8">
            {instances.map((instance) => (
              <Card key={instance.instanceId} className="border-white/10 bg-white/5">
                <CardHeader className="flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                  <div>
                    <CardTitle className="text-xl text-white">{instance.instanceName}</CardTitle>
                    <CardDescription>{instance.data.length} indexers</CardDescription>
                  </div>
                  <p className="text-xs text-white/40">ID: {instance.instanceId}</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  {instance.data.length === 0 ? (
                    <p className="text-sm text-white/60">No indexers configured on this instance.</p>
                  ) : (
                    instance.data.map((indexer) => {
                      const key = `${instance.instanceId}:${indexer.id}`;
                      return (
                        <IndexerRow
                          key={key}
                          indexer={indexer}
                          instanceId={instance.instanceId}
                          onTest={handleTest}
                          onUpdate={handleUpdate}
                          testing={testingKey === key && testMutation.isPending}
                          expanded={expandedKey === key}
                          onToggleDetails={() => handleToggleDetails(instance.instanceId, indexer.id)}
                        />
                      );
                    })
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </section>
  );
};


















