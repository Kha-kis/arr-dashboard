import type { SearchResult } from "@arr/shared";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { SearchResultsTable } from "../search-results-table";

const result: SearchResult = {
	id: "synthetic-guid",
	title: "A",
	indexer: "Synthetic Indexer",
	indexerId: 7,
	protocol: "torrent",
	instanceId: "prowlarr-1",
	instanceName: "Synthetic Prowlarr",
	rejected: true,
	rejectionReasons: ['Release "PRIVATE_RELEASE_A" rejected by private-indexer.invalid'],
};

beforeEach(() => window.localStorage.clear());

const renderResults = () =>
	render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<SearchResultsTable results={[result]} />
			</IncognitoProvider>
		</ColorThemeProvider>,
	);

describe("Search result privacy", () => {
	it("displays absent metrics as Unknown rather than zero", () => {
		renderResults();
		expect(screen.getByText("Size Unknown")).toBeInTheDocument();
		expect(screen.getByText("Seeders Unknown")).toBeInTheDocument();
		expect(screen.getByText("Leechers Unknown")).toBeInTheDocument();
	});
	it("does not expose a free-form rejection reason in incognito mode", () => {
		window.localStorage.setItem("arr-dashboard-incognito-mode", "true");

		renderResults();

		expect(
			screen.getByText("Indexer rejected this release. Review its status in Prowlarr."),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/PRIVATE_RELEASE_A|private-indexer\.invalid/),
		).not.toBeInTheDocument();
	});

	it("preserves the rejection reason in normal mode", () => {
		renderResults();

		expect(
			screen.getByText('Release "PRIVATE_RELEASE_A" rejected by private-indexer.invalid'),
		).toBeInTheDocument();
	});
});
