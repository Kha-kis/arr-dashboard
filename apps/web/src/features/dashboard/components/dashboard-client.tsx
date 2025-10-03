'use client';

import { useEffect, useMemo, useState } from "react";
import type { QueueItem } from "@arr/shared";
import { useCurrentUser } from "../../../hooks/api/useCurrentUser";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useMultiInstanceQueueQuery } from "../../../hooks/api/useDashboard";
import { useQueueActions } from "../../../hooks/api/useQueueActions";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import { Button } from "../../../components/ui/button";
import { QueueTable } from "./queue-table";
import ManualImportModal from "../../manual-import/components/manual-import-modal";

const SERVICE_FILTERS = [
  { value: "all" as const, label: "All services" },
  { value: "sonarr" as const, label: "Sonarr" },
  { value: "radarr" as const, label: "Radarr" },
];

export const DashboardClient = () => {
  const {
    data: currentUser,
    isLoading: userLoading,
    error: userError,
  } = useCurrentUser();

  const servicesQuery = useServicesQuery({ enabled: Boolean(currentUser) });
  const services = useMemo(() => servicesQuery.data ?? [], [servicesQuery.data]);
  const servicesLoading = servicesQuery.isLoading;
  const { refetch } = servicesQuery;

  const queueQuery = useMultiInstanceQueueQuery();
  const queueAggregated = useMemo(() => queueQuery.data?.aggregated ?? [], [queueQuery.data?.aggregated]);
  const queueInstances = useMemo(() => queueQuery.data?.instances ?? [], [queueQuery.data?.instances]);

  const totalQueueItems = queueQuery.data?.totalCount ?? queueAggregated.length;

  const queueActions = useQueueActions();

  const [queueMessage, setQueueMessage] = useState<{ type: "success"; message: string } | null>(null);

  useEffect(() => {
    if (!queueMessage) {
      return;
    }
    const timeout = window.setTimeout(() => setQueueMessage(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [queueMessage]);
  const [serviceFilter, setServiceFilter] = useState<(typeof SERVICE_FILTERS)[number]["value"]>("all");
  const [instanceFilter, setInstanceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const isLoading = userLoading || (servicesLoading && Boolean(currentUser));

  const groupedByService = useMemo(() => {
    const groups: Record<string, number> = {};
    for (const instance of services) {
      groups[instance.service] = (groups[instance.service] ?? 0) + 1;
    }
    return groups;
  }, [services]);

  const instanceOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const instance of queueInstances) {
      seen.set(instance.instanceId, instance.instanceName);
    }
    return Array.from(seen.entries()).map(([value, label]) => ({ value, label }));
  }, [queueInstances]);

  const statusOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of queueAggregated) {
      const label = item.status ?? "Pending";
      const value = label.toLowerCase();
      if (!map.has(value)) {
        map.set(value, label);
      }
    }
    return Array.from(map.entries()).map(([value, label]) => ({ value, label }));
  }, [queueAggregated]);

  const filteredQueueItems = useMemo(() => {
    return queueAggregated.filter((item) => {
      if (serviceFilter !== "all" && item.service !== serviceFilter) {
        return false;
      }
      if (instanceFilter !== "all" && item.instanceId !== instanceFilter) {
        return false;
      }
      const statusValue = (item.status ?? "Pending").toLowerCase();
      if (statusFilter !== "all" && statusValue !== statusFilter) {
        return false;
      }
      return true;
    });
  }, [queueAggregated, serviceFilter, instanceFilter, statusFilter]);

  const statusSummary = useMemo(() => {
    const summary = new Map<string, number>();
    for (const item of filteredQueueItems) {
      const label = item.status ?? "Pending";
      summary.set(label, (summary.get(label) ?? 0) + 1);
    }
    return Array.from(summary.entries()).sort((a, b) => b[1] - a[1]);
  }, [filteredQueueItems]);

  const filtersActive =
    serviceFilter !== "all" || instanceFilter !== "all" || statusFilter !== "all";

  const emptyMessage =
    filteredQueueItems.length === 0 && queueAggregated.length > 0
      ? "No queue items match the current filters."
      : undefined;

  const [manualImportContext, setManualImportContext] = useState<{
    instanceId: string;
    instanceName: string;
    service: "sonarr" | "radarr";
    downloadId?: string;
    open: boolean;
  }>({
    instanceId: "",
    instanceName: "",
    service: "sonarr",
    downloadId: undefined,
    open: false,
  });

  const openManualImport = (item: QueueItem) => {
    if (!item.instanceId || !item.instanceName) {
      return;
    }
    setManualImportContext({
      instanceId: item.instanceId,
      instanceName: item.instanceName,
      service: item.service,
      downloadId: item.downloadId,
      open: true,
    });
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-white/30 border-t-white" />
      </div>
    );
  }

  if (userError) {
    return (
      <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-6 text-red-200">
        <p className="text-sm font-medium">Failed to load user session. Please refresh.</p>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-12 text-center text-white/80">
        <h2 className="text-2xl font-semibold text-white">Sign in required</h2>
        <p className="max-w-sm text-sm">
          You are not authenticated. Log in through the dashboard API to manage Sonarr, Radarr, and Prowlarr instances.
        </p>
      </div>
    );
  }

  const handleQueueRetry = (items: QueueItem[]) => queueActions.executeAsync("retry", items);
  const handleQueueRemove = (items: QueueItem[], options?: QueueActionOptions) =>
    queueActions.executeAsync("delete", items, options);
  const handleQueueChangeCategory = (items: QueueItem[]) =>
    queueActions.executeAsync("delete", items, {
      removeFromClient: false,
      blocklist: false,
      changeCategory: true,
    });



  const resetFilters = () => {
    setServiceFilter("all");
    setInstanceFilter("all");
    setStatusFilter("all");
  };

  return (
    <section className="flex flex-col gap-10">
      <header className="space-y-2">
        <p className="text-sm font-medium uppercase text-white/60">Welcome back</p>
        <h1 className="text-4xl font-semibold text-white">Hi {currentUser.username}</h1>
        <p className="text-white/70">
          Here is a quick snapshot of the configured *arr instances. Use the refresh button to pull the latest configuration snapshot.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void refetch()}
            className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/20"
          >
            Refresh data
          </button>
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {["sonarr", "radarr", "prowlarr"].map((service) => {
          const count = groupedByService[service] ?? 0;
          return (
            <article
              key={service}
              className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur transition hover:border-white/20"
            >
              <p className="text-sm uppercase tracking-wide text-white/60">{service}</p>
              <p className="mt-2 text-3xl font-semibold text-white">{count}</p>
              <p className="mt-1 text-sm text-white/70">
                {count === 0 ? "No instances configured yet." : "Active instances configured."}
              </p>
            </article>
          );
        })}
        <article className="rounded-2xl border border-white/10 bg-white/5 p-6 backdrop-blur">
          <p className="text-sm uppercase tracking-wide text-white/60">Queue</p>
          <p className="mt-2 text-3xl font-semibold text-white">{totalQueueItems}</p>
          <p className="mt-1 text-sm text-white/70">Items across Sonarr and Radarr queues.</p>
        </article>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-semibold text-white">Configured Instances</h2>
        {services.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/20 p-6 text-center text-white/70">
            Nothing here yet. Add an instance via the API to see it appear in real time.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-white/10 bg-white/5">
            <table className="min-w-full divide-y divide-white/10 text-sm text-white/80">
              <thead className="bg-white/5 text-left text-xs uppercase tracking-wide text-white/60">
                <tr>
                  <th className="px-4 py-3">Label</th>
                  <th className="px-4 py-3">Service</th>
                  <th className="px-4 py-3">Base URL</th>
                  <th className="px-4 py-3">Tags</th>
                  <th className="px-4 py-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {services.map((instance) => (
                  <tr key={instance.id}>
                    <td className="px-4 py-3 font-medium text-white">{instance.label}</td>
                    <td className="px-4 py-3 capitalize">{instance.service}</td>
                    <td className="px-4 py-3 text-white/70">{instance.baseUrl}</td>
                    <td className="px-4 py-3">
                      {instance.tags.length === 0 ? (
                        <span className="text-white/40">-</span>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {instance.tags.map((tag) => (
                            <span
                              key={tag.id}
                              className="rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-white"
                            >
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span
                        className={`inline-flex items-center justify-center rounded-full px-3 py-1 text-xs font-semibold ${
                          instance.enabled ? "bg-emerald-500/20 text-emerald-200" : "bg-white/10 text-white/50"
                        }`}
                      >
                        {instance.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-1 md:flex-row md:items-center md:gap-3">
            <h2 className="text-xl font-semibold text-white">Active Queue</h2>
            <span className="text-sm text-white/60">
              Monitoring {queueInstances.length} instance{queueInstances.length === 1 ? "" : "s"}
            </span>
          </div>
          <span className="text-xs text-white/50">
            Showing {filteredQueueItems.length} of {totalQueueItems} items
          </span>
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
          <div className="flex min-w-[160px] flex-col gap-1 text-sm text-white/80">
            <label className="text-xs uppercase text-white/50" htmlFor="queue-service-filter">
              Service
            </label>
            <select
              id="queue-service-filter"
              value={serviceFilter}
              onChange={(event) => setServiceFilter(event.target.value as (typeof SERVICE_FILTERS)[number]["value"])}
              className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
              style={{ color: "#f8fafc" }}
            >
              {SERVICE_FILTERS.map((option) => (
                <option key={option.value} value={option.value} className="bg-slate-900 text-white">
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-[200px] flex-col gap-1 text-sm text-white/80">
            <label className="text-xs uppercase text-white/50" htmlFor="queue-instance-filter">
              Instance
            </label>
            <select
              id="queue-instance-filter"
              value={instanceFilter}
              onChange={(event) => setInstanceFilter(event.target.value)}
              className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
              style={{ color: "#f8fafc" }}
            >
              <option value="all" className="bg-slate-900 text-white">
                All instances
              </option>
              {instanceOptions.map((option) => (
                <option key={option.value} value={option.value} className="bg-slate-900 text-white">
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-[200px] flex-col gap-1 text-sm text-white/80">
            <label className="text-xs uppercase text-white/50" htmlFor="queue-status-filter">
              Status
            </label>
            <select
              id="queue-status-filter"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="rounded-md border border-white/20 bg-slate-900/80 px-3 py-2 text-sm text-white focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
              style={{ color: "#f8fafc" }}
            >
              <option value="all" className="bg-slate-900 text-white">
                All statuses
              </option>
              {statusOptions.map((option) => (
                <option key={option.value} value={option.value} className="bg-slate-900 text-white">
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="ml-auto">
            <Button variant="ghost" onClick={resetFilters} disabled={!filtersActive}>
              Reset
            </Button>
          </div>
        </div>

        {queueMessage && (
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            {queueMessage.message}
          </div>
        )}
        {queueActions.error && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {queueActions.error.message || "Failed to process the last queue action. Please try again."}
          </div>
        )}
        <QueueTable
          items={filteredQueueItems}
          loading={queueQuery.isLoading}
          pending={queueActions.isPending}
          onRetry={handleQueueRetry}
          onManualImport={(items) => {
            const [first] = items;
            if (first) {
              openManualImport(first);
            }
          }}
          onRemove={handleQueueRemove}
          onChangeCategory={handleQueueChangeCategory}
          emptyMessage={emptyMessage}
        />
      </div>

      <ManualImportModal
        instanceId={manualImportContext.instanceId}
        instanceName={manualImportContext.instanceName}
        service={manualImportContext.service}
        downloadId={manualImportContext.downloadId}
        open={manualImportContext.open}
        onOpenChange={(open) => setManualImportContext((prev) => ({ ...prev, open }))}
        onCompleted={(result) => {
          setQueueMessage({
            type: "success",
            message:
              result.imported === 1
                ? "Manual import requested for 1 file."
                : `Manual import requested for ${result.imported} files.`,
          });
          void queueQuery.refetch();
        }}
      />
    </section>
  );
};














