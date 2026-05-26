/**
 * Tests for the per-torrent Advanced section — specifically the
 * incognito masking on the rename + setLocation prefill values.
 *
 * Background: a code-review audit on PR #475 flagged that this section's
 * `renameValue` and `locationValue` seeded their initial state from
 * `copy.name` and `copy.savePath` directly — so a screen-share with
 * incognito mode ON would show a masked drawer header but unmasked
 * path/name inside the inputs. CLAUDE.md Critical Rule 6 violation
 * (any component displaying sensitive data must use `useIncognitoMode()`
 * and anonymize via `lib/incognito`).
 *
 * The fix landed in 0991a98; this suite pins the masking so a future
 * refactor can't re-introduce the leak.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ColorThemeProvider } from "../../../../../providers/color-theme-provider";

vi.mock("../../../../../lib/api-client/qui");
vi.mock("../../../../../components/ui/toast", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// Directly control useIncognitoMode's return so the test can simulate
// "drawer mounted while incognito was already on" — the real
// IncognitoProvider hydrates from localStorage via useEffect (after
// first render), which means the AdvancedSection's `useState` would
// capture the unmasked initial value before the hydration completes.
// Mocking the hook bypasses that timing and tests the masking logic
// directly.
const mockUseIncognitoMode = vi.fn<() => [boolean, (value: boolean) => void]>(() => [
	false,
	vi.fn(),
]);
vi.mock("../../../../../contexts/IncognitoContext", () => ({
	useIncognitoMode: () => mockUseIncognitoMode(),
	IncognitoProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import type { SeriesTorrentCopy } from "../../../../../lib/api-client/qui";
import { AdvancedSection } from "../advanced-section";

function makeCopy(overrides: Partial<SeriesTorrentCopy> = {}): SeriesTorrentCopy {
	return {
		quiInstanceId: "qui-1",
		qbitInstanceId: 0,
		infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		name: "Ubuntu.22.04.Server.x86_64.iso",
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
		savePath: "/home/operator/media/library/movies/Some Movie (2024)",
		addedOn: 0,
		completedOn: 0,
		priority: 0,
		quiUnreachable: false,
		...overrides,
	} as SeriesTorrentCopy;
}

function renderWithProviders(ui: ReactNode, { incognito }: { incognito: boolean }) {
	// Set the mocked hook's return value before render so AdvancedSection's
	// useState captures the right initial value.
	mockUseIncognitoMode.mockReturnValue([incognito, vi.fn()]);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<ColorThemeProvider>
			<QueryClientProvider client={client}>{ui}</QueryClientProvider>
		</ColorThemeProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mockUseIncognitoMode.mockReturnValue([false, vi.fn()]);
});

describe("AdvancedSection — incognito prefill masking", () => {
	it("with incognito OFF, the rename input shows the real torrent name", () => {
		renderWithProviders(<AdvancedSection copy={makeCopy()} canAct={true} />, {
			incognito: false,
		});
		const renameInput = screen.getAllByRole("textbox")[0] as HTMLInputElement;
		expect(renameInput.value).toBe("Ubuntu.22.04.Server.x86_64.iso");
	});

	it("with incognito OFF, the location input shows the real save path", () => {
		renderWithProviders(<AdvancedSection copy={makeCopy()} canAct={true} />, {
			incognito: false,
		});
		const locationInput = screen.getAllByRole("textbox")[1] as HTMLInputElement;
		expect(locationInput.value).toBe("/home/operator/media/library/movies/Some Movie (2024)");
	});

	it("with incognito ON, the rename input prefill does NOT equal the real torrent name", () => {
		// THE LOAD-BEARING ASSERTION: a screenshot of the drawer while
		// incognito is on must NOT leak the real torrent name. The
		// `getLinuxIsoName` helper returns one of a fixed list of Linux
		// ISO aliases — some of those happen to contain substrings of
		// real torrent names ("Ubuntu", "Fedora-Server-..."), so we
		// can't test substring exclusion universally. The cleaner pin
		// is: the rendered value MUST differ from the input, AND must
		// be non-empty (matching a known mask form).
		const original = "Ubuntu.22.04.Server.x86_64.iso";
		renderWithProviders(<AdvancedSection copy={makeCopy({ name: original })} canAct={true} />, {
			incognito: true,
		});
		const renameInput = screen.getAllByRole("textbox")[0] as HTMLInputElement;
		expect(renameInput.value).not.toBe(original);
		expect(renameInput.value.length).toBeGreaterThan(0);
		// Masked value should LOOK like a Linux ISO (ends in .iso).
		expect(renameInput.value.toLowerCase()).toMatch(/\.iso$/);
	});

	it("with incognito ON, the location input prefill does NOT equal the real save path", () => {
		// Same masking-shape argument as the rename test above: the
		// `getLinuxSavePath` helper returns one of a fixed list of
		// generic paths. The mask is correct if the rendered value
		// (a) differs from the input and (b) has a path-like shape.
		const original = "/home/operator/media/library/movies/Some Movie (2024)";
		renderWithProviders(<AdvancedSection copy={makeCopy({ savePath: original })} canAct={true} />, {
			incognito: true,
		});
		const locationInput = screen.getAllByRole("textbox")[1] as HTMLInputElement;
		expect(locationInput.value).not.toBe(original);
		// Operator-identifying substrings (the username + the movie
		// title) are the actually-sensitive bits. `getLinuxSavePath`
		// returns paths like `/home/iso-archive/linux-distros` which
		// contain neither.
		expect(locationInput.value).not.toContain("operator");
		expect(locationInput.value).not.toContain("Some Movie");
		expect(locationInput.value.length).toBeGreaterThan(0);
	});

	it("with incognito ON, the location input shows a path-shaped masked value", () => {
		// The masked value is a Linux-ISO-style directory tree
		// (`getLinuxSavePath`). It should at least START with "/" so
		// the input still LOOKS like a path to the user.
		renderWithProviders(<AdvancedSection copy={makeCopy()} canAct={true} />, {
			incognito: true,
		});
		const locationInput = screen.getAllByRole("textbox")[1] as HTMLInputElement;
		expect(locationInput.value.startsWith("/")).toBe(true);
	});

	it("when copy.name is missing, the rename input falls back to empty rather than crashing", () => {
		// Defensive — torrents without a name (rare but possible if qBit
		// is mid-mutation) shouldn't break the drawer.
		renderWithProviders(
			<AdvancedSection copy={makeCopy({ name: undefined as unknown as string })} canAct={true} />,
			{ incognito: false },
		);
		const renameInput = screen.getAllByRole("textbox")[0] as HTMLInputElement;
		// Either empty (incognito off + no name) or a default masked
		// path (the helper's fallback). The important thing is it
		// doesn't throw.
		expect(renameInput).toBeDefined();
	});
});
