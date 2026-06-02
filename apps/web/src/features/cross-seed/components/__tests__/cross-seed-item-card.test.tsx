/**
 * Render-test pin for CrossSeedItemCard's tracker display.
 *
 * Tracker passkeys are user-identifying tokens embedded in private-tracker
 * announce URLs (e.g. `https://tracker.example.org/{40-hex}/announce` or
 * `?passkey=…`). Leaking one lets anyone seed/leech as that user and is an
 * ejection-worthy offense on most private trackers. The wire-level strip
 * happens in `wireCrossSeedMatchSchema.transform` (`apps/api/src/lib/qui/
 * client-factory.ts`) so this card *should* only ever receive a bare
 * hostname, but pin it here so a future regression — wrong field passed,
 * transform reverted, new code path bypassing the strip — fails loudly.
 */

import type { CrossSeedDiscoveryItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { CrossSeedItemCard } from "../cross-seed-item-card";

function Wrapper({ children }: { children: ReactNode }) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<ColorThemeProvider>
				<IncognitoProvider>{children}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
}

const baseItem = (overrides?: Partial<CrossSeedDiscoveryItem>): CrossSeedDiscoveryItem => ({
	libraryCacheId: "lib-1",
	arrInstanceId: "arr-1",
	arrInstanceLabel: "Sonarr Main",
	arrService: "sonarr",
	itemType: "series",
	arrItemId: 42,
	title: "Some Show (2024)",
	year: 2024,
	primary: {
		hash: "a".repeat(40),
		qbitInstanceId: 1,
		qbitInstanceName: "qbit-home",
		state: "uploading",
		ratio: 1.5,
		tracker: "tracker.example.com",
	},
	siblings: [
		{
			hash: "b".repeat(40),
			name: "Some.Show.2024.1080p.WEB.x264-GROUP",
			instanceId: 1,
			instanceName: "qbit-home",
			state: "uploading",
			progress: 1,
			size: 1024 * 1024 * 1024,
			category: "",
			savePath: "/data/tv",
			contentPath: "/data/tv/show",
			tracker: "tracker.example.com",
			matchType: "release",
			tags: "",
		},
	],
	...overrides,
});

describe("CrossSeedItemCard — passkey display pin", () => {
	// The wire transform should hand us a bare hostname; assert the rendered
	// DOM contains zero passkey-shaped substring even if a future bug feeds in
	// a raw URL with `/announce/{40-hex}` or `?passkey=…`.
	const PASSKEY_PATTERN = /passkey|\/announce|[a-f0-9]{40}/i;

	it("renders nothing that looks like a passkey for a normal hostname sibling", () => {
		const { container } = render(<CrossSeedItemCard item={baseItem()} animationDelay={0} />, {
			wrapper: Wrapper,
		});

		// Defense-in-depth: hash-shaped strings ARE present internally (the React
		// `key` is the sibling hash), but they must not survive into rendered
		// text content. textContent excludes attribute values and React keys.
		expect(container.textContent ?? "").not.toMatch(PASSKEY_PATTERN);
		// Sanity that the card actually rendered (title text reaches the DOM) —
		// avoids the false-positive where a render crash also passes the
		// passkey-absence assertion. We don't pin the tracker label string itself
		// because `resolveHostnameBrand` derives a display name from the
		// hostname's identifying segment, which is a separate concern.
		expect(screen.getByText(/Some Show/)).toBeInTheDocument();
	});

	it("strips a passkey-bearing tracker string from rendered text if one ever sneaks through", () => {
		// Simulate the regression: a sibling whose `tracker` field is the raw
		// announce URL with a passkey embedded. The card has no business
		// rendering it verbatim — at worst we expect a fallback string.
		const compromised = baseItem({
			siblings: [
				{
					...baseItem().siblings[0]!,
					tracker: "https://tracker.example.com/announce/abcdef0123456789abcdef0123456789abcdef01",
				},
			],
		});
		const { container } = render(<CrossSeedItemCard item={compromised} animationDelay={0} />, {
			wrapper: Wrapper,
		});

		// Render must not bake the passkey-shaped path into visible text. If a
		// future change ever does (e.g. someone removes the wire strip and the
		// card displays `sibling.tracker` literally), this assertion fires.
		expect(container.textContent ?? "").not.toMatch(/[a-f0-9]{40}/i);
		expect(container.textContent ?? "").not.toMatch(/\/announce/);
	});
});
