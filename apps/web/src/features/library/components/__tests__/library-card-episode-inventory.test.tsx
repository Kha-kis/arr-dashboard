import type { LibraryItem } from "@arr/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { LibraryCard } from "../library-card";

const observedAt = "2026-11-23T10:00:00.000Z";
const item = {
	id: 202,
	type: "series",
	title: "Synthetic inventory series",
	instanceId: "synthetic-sonarr",
	instanceName: "Synthetic Sonarr",
	service: "sonarr",
	monitored: true,
	hasFile: true,
} satisfies LibraryItem;

function renderCard(
	episodeInventory?: { status: "fresh" | "stale" | "unknown"; observedAt: string | null },
	complete = true,
	cardItem: LibraryItem = item,
) {
	return render(
		<ColorThemeProvider>
			<IncognitoProvider>
				<LibraryCard
					item={cardItem}
					onToggleMonitor={vi.fn()}
					pending={false}
					seedingSummary={{
						trackerCount: 2,
						topHosts: ["tracker.invalid"],
						complete,
						episodeInventory,
					}}
				/>
			</IncognitoProvider>
		</ColorThemeProvider>,
	);
}

beforeEach(() => {
	localStorage.clear();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-11-23T11:00:00.000Z"));
});
afterEach(() => {
	cleanup();
	localStorage.clear();
	vi.useRealTimers();
});

describe("Library tracker episode-file observation", () => {
	it.each([true, false])("appends the original check time with complete=%s", (complete) => {
		renderCard({ status: "fresh", observedAt }, complete);
		const count = complete ? "Seeding at 2 trackers" : "At least 2 trackers observed";
		expect(
			screen.getByTitle(
				`${count}. Episode files last checked ${new Date(observedAt).toLocaleString()}.`,
			),
		).toBeInTheDocument();
		const time = screen.getByText(new Date(observedAt).toLocaleString());
		expect(time).toBeVisible();
		expect(time.tagName).toBe("TIME");
		expect(time).toHaveAttribute("datetime", observedAt);
		expect(time.parentElement).toHaveTextContent("Episode files last checked");
	});

	it("keeps an expired check visibly out of date and never exact", () => {
		renderCard({ status: "stale", observedAt });
		expect(
			screen.getByTitle(
				`At least 2 trackers observed. Episode files out of date; last checked ${new Date(observedAt).toLocaleString()}.`,
			),
		).toBeInTheDocument();
		const time = screen.getByText(new Date(observedAt).toLocaleString());
		expect(time).toBeVisible();
		expect(time).toHaveAttribute("datetime", observedAt);
		expect(time.parentElement).toHaveTextContent("Episode files out of date; last checked");
	});

	it.each([
		{ status: "unknown" as const, observedAt: null },
		{ status: "fresh" as const, observedAt: null },
		{ status: "fresh" as const, observedAt: "invalid" },
		{ status: "fresh" as const, observedAt: "2026-11-24T10:00:00.000Z" },
		{ status: "stale" as const, observedAt: "invalid" },
	])("keeps unavailable or invalid check information incomplete: %j", (inventory) => {
		const { container } = renderCard(inventory);
		expect(
			screen.getByTitle("At least 2 trackers observed. Episode file check time unavailable."),
		).toBeInTheDocument();
		expect(screen.queryByTitle(/Seeding at/)).not.toBeInTheDocument();
		expect(screen.getByText("Episode file check time unavailable.")).toBeVisible();
		expect(container.querySelector("time")).toBeNull();
	});

	it("retains legacy exact wording without inventing an observation time", () => {
		const { container } = renderCard();
		expect(screen.getByTitle("Seeding at 2 trackers")).toBeInTheDocument();
		expect(screen.queryByTitle(/Episode file/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Episode file/)).not.toBeInTheDocument();
		expect(container.querySelector("time")).toBeNull();
	});

	it("retains movie wording even if episode metadata is supplied", () => {
		const { container } = renderCard({ status: "unknown", observedAt: null }, true, {
			...item,
			type: "movie",
			service: "radarr",
		});
		expect(screen.getByTitle("Seeding at 2 trackers")).toBeInTheDocument();
		expect(screen.queryByText(/Episode file/)).not.toBeInTheDocument();
		expect(container.querySelector("time")).toBeNull();
	});

	it("retains the check time while incognito masks the item title", () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		const { container } = renderCard({ status: "fresh", observedAt });
		expect(screen.queryByText(item.title)).not.toBeInTheDocument();
		expect(container.innerHTML).not.toContain(item.title);
		expect(screen.getByTitle(/Episode files last checked/)).toBeInTheDocument();
		expect(screen.getByText(new Date(observedAt).toLocaleString())).toBeVisible();
	});
});
