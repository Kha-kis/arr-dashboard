﻿"use client";

import { useMemo } from "react";
import { useMultiInstanceHistoryQuery } from "../../../hooks/api/useDashboard";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Alert, AlertDescription, Pagination } from "../../../components/ui";
import { HistoryTable } from "./history-table";
import { SERVICE_FILTERS } from "../lib/history-utils";
import { useHistoryState } from "../hooks/use-history-state";
import { useHistoryData } from "../hooks/use-history-data";

export const HistoryClient = () => {
	const { state, actions } = useHistoryState();
	const {
		page,
		pageSize,
		startDate,
		endDate,
		searchTerm,
		serviceFilter,
		instanceFilter,
		statusFilter,
		groupByDownload,
	} = state;

	const { data, isLoading, error, refetch } = useMultiInstanceHistoryQuery({
		startDate: startDate || undefined,
		endDate: endDate || undefined,
	});

	const historyData = useHistoryData(
		data,
		{
			searchTerm,
			serviceFilter,
			instanceFilter,
			statusFilter,
			startDate,
			endDate,
		},
		groupByDownload,
	);

	const {
		allItems,
		groupedItems,
		instanceOptions,
		statusOptions,
		serviceSummary,
		statusSummary,
		filtersActive,
		emptyMessage,
	} = historyData;

	const totalRecords = groupedItems.length;
	const totalPages = Math.ceil(totalRecords / pageSize);
	const showingFrom = totalRecords > 0 ? (page - 1) * pageSize + 1 : 0;
	const showingTo = Math.min(page * pageSize, totalRecords);

	const paginatedGroups = useMemo(() => {
		const startIndex = (page - 1) * pageSize;
		return groupedItems.slice(startIndex, startIndex + pageSize);
	}, [groupedItems, page, pageSize]);

	const handleResetFilters = () => {
		actions.setSearchTerm("");
		actions.setServiceFilter("all");
		actions.setInstanceFilter("all");
		actions.setStatusFilter("all");
		actions.setStartDate("");
		actions.setEndDate("");
		actions.setPage(1);
	};

	return (
		<section className="flex flex-col gap-10">
			<header className="space-y-2">
				<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
					<div>
						<p className="text-sm font-medium uppercase text-white/60">Activity</p>
						<h1 className="text-3xl font-semibold text-white">Download History</h1>
					</div>
					<div className="flex items-center gap-3 text-sm text-white/60">
						<span>
							Tracking {allItems.length} event
							{allItems.length === 1 ? "" : "s"} across {data?.instances?.length ?? 0} instance
							{(data?.instances?.length ?? 0) === 1 ? "" : "s"}
						</span>
						<Button variant="ghost" onClick={() => void refetch()}>
							Refresh
						</Button>
					</div>
				</div>
				<p className="text-sm text-white/60">
					Review recent activity from all configured Sonarr, Radarr, and Prowlarr instances.
				</p>
			</header>

			<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				{SERVICE_FILTERS.filter((item) => item.value !== "all").map((service) => {
					const count = serviceSummary.get(service.value) ?? 0;
					return (
						<div
							key={service.value}
							className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80"
						>
							<p className="text-xs uppercase text-white/50">{service.label}</p>
							<p className="text-2xl font-semibold text-white">{count}</p>
						</div>
					);
				})}
			</div>

			<div className="flex flex-wrap items-end gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3">
				<div className="flex min-w-[140px] flex-col gap-1 text-sm text-white/80">
					<label className="text-xs uppercase text-white/50" htmlFor="history-start-date">
						From Date
					</label>
					<Input
						id="history-start-date"
						type="date"
						value={startDate}
						onChange={(event) => {
							actions.setStartDate(event.target.value);
							actions.setPage(1);
						}}
						className="border-white/20 bg-white/10 text-white"
					/>
				</div>
				<div className="flex min-w-[140px] flex-col gap-1 text-sm text-white/80">
					<label className="text-xs uppercase text-white/50" htmlFor="history-end-date">
						To Date
					</label>
					<Input
						id="history-end-date"
						type="date"
						value={endDate}
						onChange={(event) => {
							actions.setEndDate(event.target.value);
							actions.setPage(1);
						}}
						className="border-white/20 bg-white/10 text-white"
					/>
				</div>
				<div className="flex min-w-[200px] flex-col gap-1 text-sm text-white/80">
					<label className="text-xs uppercase text-white/50" htmlFor="history-search">
						Search
					</label>
					<Input
						id="history-search"
						value={searchTerm}
						onChange={(event) => actions.setSearchTerm(event.target.value)}
						placeholder="Search title, client, or indexer"
						className="border-white/20 bg-white/10 text-white placeholder:text-white/40"
					/>
				</div>
				<div className="flex min-w-[160px] flex-col gap-1 text-sm text-white/80">
					<label className="text-xs uppercase text-white/50" htmlFor="history-service-filter">
						Service
					</label>
					<select
						id="history-service-filter"
						value={serviceFilter}
						onChange={(event) =>
							actions.setServiceFilter(
								event.target.value as (typeof SERVICE_FILTERS)[number]["value"],
							)
						}
						className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-sm text-white focus:border-sky-400 focus:outline-none [&>option]:bg-slate-800 [&>option]:text-white"
					>
						{SERVICE_FILTERS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</div>
				<div className="flex min-w-[200px] flex-col gap-1 text-sm text-white/80">
					<label className="text-xs uppercase text-white/50" htmlFor="history-instance-filter">
						Instance
					</label>
					<select
						id="history-instance-filter"
						value={instanceFilter}
						onChange={(event) => actions.setInstanceFilter(event.target.value)}
						className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-sm text-white focus:border-sky-400 focus:outline-none [&>option]:bg-slate-800 [&>option]:text-white"
					>
						<option value="all">All instances</option>
						{instanceOptions.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</div>
				<div className="flex min-w-[200px] flex-col gap-1 text-sm text-white/80">
					<label className="text-xs uppercase text-white/50" htmlFor="history-status-filter">
						Status
					</label>
					<select
						id="history-status-filter"
						value={statusFilter}
						onChange={(event) => actions.setStatusFilter(event.target.value)}
						className="rounded-md border border-white/20 bg-white/10 px-2 py-1 text-sm text-white focus:border-sky-400 focus:outline-none [&>option]:bg-slate-800 [&>option]:text-white"
					>
						<option value="all">All statuses</option>
						{statusOptions.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
				</div>
				<div className="ml-auto flex items-center gap-3">
					<label className="flex items-center gap-2 text-sm text-white/70 cursor-pointer">
						<input
							type="checkbox"
							checked={groupByDownload}
							onChange={(e) => {
								actions.setGroupByDownload(e.target.checked);
								actions.setPage(1);
							}}
							className="rounded border-white/20 bg-white/10 text-sky-500 focus:ring-sky-400"
						/>
						Group by download
					</label>
					<Button variant="ghost" onClick={handleResetFilters} disabled={!filtersActive}>
						Reset
					</Button>
				</div>
			</div>

			{totalRecords > 0 && (
				<Pagination
					currentPage={page}
					totalItems={totalRecords}
					pageSize={pageSize}
					onPageChange={(newPage) => actions.setPage(newPage)}
					onPageSizeChange={(newPageSize) => {
						actions.setPageSize(newPageSize);
						actions.setPage(1);
					}}
					pageSizeOptions={[25, 50, 100]}
				/>
			)}

			{statusSummary.length > 0 && (
				<div className="flex flex-wrap gap-3">
					{statusSummary.map(([label, count]) => (
						<div
							key={label}
							className="flex flex-col gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80"
						>
							<span className="text-xs uppercase text-white/50">{label}</span>
							<span className="text-lg font-semibold text-white">{count}</span>
						</div>
					))}
				</div>
			)}

			{error && (
				<Alert variant="danger">
					<AlertDescription>
						Unable to load history data. Please refresh and try again.
					</AlertDescription>
				</Alert>
			)}

			<HistoryTable
				groups={paginatedGroups}
				loading={isLoading}
				emptyMessage={emptyMessage}
				groupingEnabled={groupByDownload}
			/>
		</section>
	);
};
