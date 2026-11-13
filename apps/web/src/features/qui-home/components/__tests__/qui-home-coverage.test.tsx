import type { QuiAttentionResponse, QuiSummaryResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const state = vi.hoisted(() => ({
	summary: null as QuiSummaryResponse | null,
	attention: null as QuiAttentionResponse | null,
}));

vi.mock("../../../../hooks/api/useQui", () => ({
	useQuiSummary: () => ({ data: state.summary, isLoading: false, isError: false }),
	useQuiAttention: () => ({ data: state.attention, isLoading: false, isError: false }),
}));

import { QuiHomeClient } from "../qui-home-client";

const coverage = (status: QuiSummaryResponse["inventoryCoverage"]["status"]) => ({
	status,
	currentInstances: status === "current" ? 1 : 0,
	lastKnownInstances: status === "last-known" ? 1 : 0,
	unavailableInstances: status === "unavailable" ? 1 : 0,
	incompleteInstances: 0,
	oldestFetchedAt: status === "unavailable" ? null : "2026-09-29T08:00:00.000Z",
});

function summary(status: QuiSummaryResponse["inventoryCoverage"]["status"]): QuiSummaryResponse {
	return {
		totalTorrents: 0,
		byState: { seeding: 0, downloading: 0, paused: 0, stalled: 0, error: 0, other: 0 },
		avgRatio: 0,
		lowRatioCount: 0,
		dlSpeed: 0,
		upSpeed: 0,
		lastSyncAt: null,
		lastSyncOk: null,
		configuredInstances: 1,
		qbitInstances: [],
		inventoryCoverage: coverage(status),
		topologyCoverage: status === "unavailable" ? "unavailable" : "current",
		throughputCoverage: status === "unavailable" ? "unavailable" : "current",
	};
}

function attention(
	status: QuiAttentionResponse["inventoryCoverage"]["status"],
): QuiAttentionResponse {
	return {
		items: [],
		totalCount: 0,
		inventoryCoverage: coverage(status),
		trackerCoverage: status === "unavailable" ? "unavailable" : "current",
		fileCoverage: { status: "current", issueCount: 0, oldestBuiltAt: "2026-09-29T08:00:00.000Z" },
	};
}

function renderHome() {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<QuiHomeClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	window.localStorage.clear();
	state.summary = summary("current");
	state.attention = attention("current");
});

describe("qUI home coverage presentation", () => {
	it("withholds an all-clear when the FileID inventory is unavailable", () => {
		state.attention = {
			...attention("current"),
			fileCoverage: { status: "unavailable", issueCount: 0, oldestBuiltAt: null },
		};
		renderHome();
		expect(screen.queryByText(/No torrents currently need attention/i)).not.toBeInTheDocument();
		expect(screen.getByText(/file inventory unavailable/i)).toBeInTheDocument();
	});

	it("reports a saved file issue count even when no current torrent row matches", () => {
		state.attention = {
			...attention("current"),
			fileCoverage: { status: "partial", issueCount: 1, oldestBuiltAt: "2026-09-29T08:00:00.000Z" },
		};
		renderHome();
		expect(
			screen.getByText(/saved file inventory reports 1 affected torrent/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/No torrents currently need attention/i)).not.toBeInTheDocument();
	});

	it("shows a file discrepancy while incognito mode masks the torrent name", () => {
		window.localStorage.setItem("arr-dashboard-incognito-mode", "true");
		state.attention = {
			...attention("current"),
			items: [
				{
					quiInstanceId: "qui-one",
					hash: "a".repeat(40),
					name: "synthetic-private-torrent",
					state: "seeding",
					ratio: 1,
					size: 100,
					qbitInstanceId: 1,
					qbitInstanceName: null,
					severity: "warning",
					reason: "1 file size differs from qBittorrent",
					libraryContext: null,
				},
			],
			totalCount: 1,
			fileCoverage: { status: "partial", issueCount: 1, oldestBuiltAt: "2026-09-29T08:00:00.000Z" },
		};
		renderHome();
		expect(screen.getByText(/1 file size differs from qBittorrent/i)).toBeInTheDocument();
		expect(screen.queryByText("synthetic-private-torrent")).not.toBeInTheDocument();
	});

	it("does not display zero KPIs or an all-clear for an unavailable provider", () => {
		state.summary = summary("unavailable");
		state.attention = attention("unavailable");
		renderHome();
		expect(screen.getByText(/Torrent inventory unavailable/i)).toBeInTheDocument();
		expect(screen.queryByText(/all healthy/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/No torrents currently need attention/i)).not.toBeInTheDocument();
	});

	it("labels last-known empty evidence rather than claiming current all-clear", () => {
		state.summary = summary("last-known");
		state.attention = attention("last-known");
		renderHome();
		expect(screen.getByText(/Last-known torrent inventory/i)).toBeInTheDocument();
		expect(screen.queryByText(/No torrents currently need attention/i)).not.toBeInTheDocument();
	});
});
