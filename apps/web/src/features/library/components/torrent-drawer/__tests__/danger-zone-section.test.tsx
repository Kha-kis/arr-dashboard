/**
 * Trust-critical tests for the per-torrent danger-zone section.
 *
 * File deletion remains unavailable until physical ownership across shared
 * storage can be proven. These tests pin both the visible explanation and
 * the sole supported delete payload (`deleteFiles: false`).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ColorThemeProvider } from "../../../../../providers/color-theme-provider";

// Mock the qui API client — every mutation flows through these post*
// functions and we want to inspect the payload arguments.
vi.mock("../../../../../lib/api-client/qui");

import type { SeriesTorrentCopy } from "../../../../../lib/api-client/qui";
import * as quiApi from "../../../../../lib/api-client/qui";
import { DangerZoneSection } from "../danger-zone-section";

// Stub the toast module so tests don't depend on a real toast root in
// jsdom. Each call's success/error message is captured here.
vi.mock("../../../../../components/ui/toast", () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}));

function makeCopy(overrides: Partial<SeriesTorrentCopy> = {}): SeriesTorrentCopy {
	return {
		quiInstanceId: "qui-1",
		qbitInstanceId: 0,
		infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		name: "Linux ISO",
		role: "library",
		state: "seeding",
		progress: 1,
		size: 1024,
		ratio: 2.5,
		seedingTime: 0,
		uploadedTotal: 0,
		downloadedTotal: 0,
		numSeeds: 5,
		numLeechs: 0,
		dlSpeed: 0,
		upSpeed: 0,
		eta: 0,
		tags: [],
		category: "",
		savePath: "/data/media",
		addedOn: 0,
		completedOn: 0,
		priority: 0,
		quiUnreachable: false,
		...overrides,
	} as SeriesTorrentCopy;
}

function renderWithClient(ui: ReactNode) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	// ColorThemeProvider is required because the Button component uses
	// useColorTheme via useThemeGradient. Without the provider every
	// render throws "useColorTheme must be used within a ColorThemeProvider".
	return render(
		<ColorThemeProvider>
			<QueryClientProvider client={client}>{ui}</QueryClientProvider>
		</ColorThemeProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("DangerZoneSection — confirm gating", () => {
	it("renders both initial buttons when no confirm is pending", () => {
		renderWithClient(<DangerZoneSection copy={makeCopy()} canAct={true} />);
		expect(screen.getByRole("button", { name: /Delete \(keep files\)/i })).toBeTruthy();
		expect(screen.getByRole("button", { name: /Delete with files/i })).toBeTruthy();
		// No "Yes, delete" button until the user picks a variant.
		expect(screen.queryByRole("button", { name: /Yes, delete/i })).toBeNull();
	});

	it("disables both initial buttons when canAct is false", () => {
		renderWithClient(<DangerZoneSection copy={makeCopy()} canAct={false} />);
		const keep = screen.getByRole("button", {
			name: /Delete \(keep files\)/i,
		}) as HTMLButtonElement;
		const withFiles = screen.getByRole("button", {
			name: /Delete with files/i,
		}) as HTMLButtonElement;
		expect(keep.disabled).toBe(true);
		expect(withFiles.disabled).toBe(true);
	});

	it("shows a non-destructive confirmation message when 'keep files' was clicked", async () => {
		renderWithClient(<DangerZoneSection copy={makeCopy()} canAct={true} />);
		fireEvent.click(screen.getByRole("button", { name: /Delete \(keep files\)/i }));
		// "Files on disk are kept" must appear; the destructive
		// "deletes ... files on disk" message must NOT.
		expect(screen.getByText(/Files on disk are kept/i)).toBeTruthy();
		expect(screen.queryByText(/all files on disk/i)).toBeNull();
	});

	it("keeps file deletion visible but unavailable until shared storage is verified", async () => {
		renderWithClient(<DangerZoneSection copy={makeCopy()} canAct={true} />);
		const withFiles = screen.getByRole("button", {
			name: /Delete with files/i,
		}) as HTMLButtonElement;
		expect(withFiles.disabled).toBe(true);
		expect(screen.getByText(/shared-storage ownership cannot be verified/i)).toBeTruthy();
		fireEvent.click(withFiles);
		expect(screen.queryByRole("button", { name: /Yes, delete everything/i })).toBeNull();
	});

	it("Cancel returns to the initial state without firing the mutation", async () => {
		vi.spyOn(quiApi, "postQuiTorrentAction").mockResolvedValue({} as never);
		renderWithClient(<DangerZoneSection copy={makeCopy()} canAct={true} />);
		fireEvent.click(screen.getByRole("button", { name: /Delete \(keep files\)/i }));
		fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
		// Back to initial buttons; mutation never called.
		expect(screen.getByRole("button", { name: /Delete \(keep files\)/i })).toBeTruthy();
		expect(quiApi.postQuiTorrentAction).not.toHaveBeenCalled();
	});
});

describe("DangerZoneSection — payload correctness (the audit-flagged risk)", () => {
	// A future refactor must not turn the keep-files control into a
	// destructive file deletion request.

	it("sends deleteFiles=false when the operator picked 'keep files'", async () => {
		const postQuiTorrentAction = vi
			.spyOn(quiApi, "postQuiTorrentAction")
			.mockResolvedValue({} as never);

		renderWithClient(<DangerZoneSection copy={makeCopy()} canAct={true} />);
		fireEvent.click(screen.getByRole("button", { name: /Delete \(keep files\)/i }));
		fireEvent.click(screen.getByRole("button", { name: /Yes, delete/i }));

		await waitFor(() => {
			expect(postQuiTorrentAction).toHaveBeenCalledTimes(1);
		});

		expect(postQuiTorrentAction).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "delete",
				payload: { deleteFiles: false },
			}),
		);
	});

	it("never sends deleteFiles=true from the unavailable control", async () => {
		const postQuiTorrentAction = vi
			.spyOn(quiApi, "postQuiTorrentAction")
			.mockResolvedValue({} as never);

		renderWithClient(<DangerZoneSection copy={makeCopy()} canAct={true} />);
		fireEvent.click(screen.getByRole("button", { name: /Delete with files/i }));
		expect(postQuiTorrentAction).not.toHaveBeenCalled();
	});

	it("passes the correct hash + instance identifiers to the mutation", async () => {
		const postQuiTorrentAction = vi
			.spyOn(quiApi, "postQuiTorrentAction")
			.mockResolvedValue({} as never);
		const copy = makeCopy({
			quiInstanceId: "qui-7",
			qbitInstanceId: 3,
			infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		});

		renderWithClient(<DangerZoneSection copy={copy} canAct={true} />);
		fireEvent.click(screen.getByRole("button", { name: /Delete \(keep files\)/i }));
		fireEvent.click(screen.getByRole("button", { name: /Yes, delete/i }));

		await waitFor(() => {
			expect(postQuiTorrentAction).toHaveBeenCalledTimes(1);
		});

		expect(postQuiTorrentAction).toHaveBeenCalledWith(
			expect.objectContaining({
				quiInstanceId: "qui-7",
				qbitInstanceId: 3,
				hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			}),
		);
	});
});
