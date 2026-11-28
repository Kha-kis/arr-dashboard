import type { LibraryItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../../../../components/ui/toast";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useLibraryQuery } from "../../../../hooks/api/useLibrary";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { DiskWastePanel } from "../../components/disk-waste-panel";
import { SeasonEpisodeList } from "../../components/season-episode-list";
import { WatchedMonitoredPanel } from "../../components/watched-monitored-panel";
import { useLibraryActions } from "../use-library-actions";

const item: LibraryItem = {
	id: 41,
	instanceId: "owned",
	instanceName: "private-instance",
	title: "private-title",
	service: "sonarr",
	type: "series",
	monitored: false,
};
let client: QueryClient,
	reads: number,
	detailReads: number,
	calls: { path: string; body: unknown }[],
	resolve: (response: Response) => void;
function Controls() {
	const actions = useLibraryActions();
	const query = useLibraryQuery();
	return (
		<>
			<span>{query.data?.items[0]?.monitored ? "observed enabled" : "observed disabled"}</span>
			<button
				disabled={actions.pendingSeasonAction !== null}
				onClick={() => void actions.handleSeasonMonitor(item, 1, true)}
			>
				season
			</button>
			<button
				disabled={actions.pendingAlbumAction !== null}
				onClick={() =>
					void actions.handleAlbumMonitor({ ...item, service: "lidarr", type: "artist" }, 51, true)
				}
			>
				album
			</button>
			<button
				disabled={actions.pendingBookAction !== null}
				onClick={() =>
					void actions.handleBookMonitor({ ...item, service: "readarr", type: "author" }, 51, true)
				}
			>
				book
			</button>
		</>
	);
}
beforeEach(() => {
	localStorage.clear();
	localStorage.setItem("arr-dashboard-incognito-mode", "true");
	toast.dismiss();
	reads = 0;
	detailReads = 0;
	calls = [];
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	vi.stubGlobal("fetch", async (path: string, options?: RequestInit) => {
		if (options?.method === "POST") {
			calls.push({ path, body: JSON.parse(String(options.body)) });
			return new Promise<Response>((release) => {
				resolve = release;
			});
		}
		if (path === "/api/library") {
			reads++;
			return new Response(
				JSON.stringify({
					items: [{ ...item, monitored: reads > 1 }],
					pagination: { page: 1, totalPages: 1, totalItems: 1, limit: 50 },
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}
		if (path.startsWith("/api/library/episodes?")) {
			detailReads++;
			return new Response(
				JSON.stringify({
					instanceId: "owned",
					seriesId: 41,
					episodes: [
						{
							id: 51,
							seriesId: 41,
							seasonNumber: 1,
							episodeNumber: 1,
							title: "private-episode",
							monitored: detailReads > 1,
							hasFile: false,
						},
					],
				}),
				{ headers: { "content-type": "application/json" } },
			);
		}
		throw Error("Unexpected synthetic read");
	});
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<Controls />
					<Toaster duration={Infinity} />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
});
afterEach(async () => {
	await waitFor(() => expect(client.isMutating()).toBe(0));
	toast.dismiss();
	cleanup();
	await client.cancelQueries();
	client.clear();
	vi.unstubAllGlobals();
});
describe("actual monitoring action hooks and production feedback", () => {
	it.each(["season", "album", "book"])(
		"%s unconfirmed action reconciles actual read state and keeps diagnostics private without replay",
		async (kind) => {
			await screen.findByText("observed disabled");
			fireEvent.click(screen.getByRole("button", { name: kind }));
			await waitFor(() => expect(calls).toHaveLength(1));
			expect(screen.getByRole("button", { name: kind })).toBeDisabled();
			expect(screen.queryByText("Monitoring update not confirmed")).not.toBeInTheDocument();
			expect(reads).toBe(1);
			await act(async () =>
				resolve(
					new Response(JSON.stringify({ error: "private-provider https://private.invalid" }), {
						status: 502,
						headers: { "content-type": "application/json" },
					}),
				),
			);
			expect(await screen.findByText("Monitoring update not confirmed")).toBeVisible();
			expect(
				screen.getByText("Reload Library to check the current state before trying again."),
			).toBeVisible();
			expect(await screen.findByText("observed enabled")).toBeVisible();
			expect(calls).toHaveLength(1);
			expect(document.querySelector('[data-sonner-toast][data-type="success"]')).toBeNull();
			expect(document.querySelector("[data-sonner-toaster]")?.textContent).not.toMatch(
				/private-title|private-instance|private-provider|private.invalid|owned/,
			);
			expect(screen.getByRole("button", { name: kind })).toBeEnabled();
		},
	);
	it("confirmed season success uses privacy-safe copy after the exact204 and observed readback", async () => {
		await screen.findByText("observed disabled");
		fireEvent.click(screen.getByRole("button", { name: "season" }));
		await waitFor(() => expect(calls).toHaveLength(1));
		await act(async () => resolve(new Response(null, { status: 204 })));
		await screen.findByText("observed enabled");
		await waitFor(() =>
			expect(document.querySelector('[data-sonner-toast][data-type="success"]')).not.toBeNull(),
		);
		expect(document.querySelector("[data-sonner-toaster]")?.textContent).not.toMatch(
			/private-title|private-instance/,
		);
		expect(calls).toHaveLength(1);
	});
	it("actual episode control reconciles detail reads after uncertainty without exposing provider diagnostics", async () => {
		render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<SeasonEpisodeList instanceId="owned" seriesId={41} seasonNumber={1} />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		);
		const button = await screen.findByTitle("Monitor episode");
		fireEvent.click(button);
		await waitFor(() => expect(calls).toHaveLength(1));
		expect(button).toBeDisabled();
		await act(async () =>
			resolve(
				new Response(JSON.stringify({ error: "private-provider" }), {
					status: 502,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		expect(await screen.findByText("Monitoring update not confirmed")).toBeVisible();
		expect(await screen.findByTitle("Unmonitor episode")).toBeEnabled();
		expect(detailReads).toBeGreaterThan(1);
		expect(calls).toEqual([
			{
				path: "/api/library/episode/monitor",
				body: { instanceId: "owned", seriesId: 41, episodeIds: [51], monitored: true },
			},
		]);
		expect(document.querySelector('[data-sonner-toast][data-type="success"]')).toBeNull();
	});
	for (const kind of ["watched", "disk"] as const)
		it.each([502, 204])(
			`${kind} actual unmonitor control uses private-safe uncertainty or proven success at %s`,
			async (status) => {
				const common = {
					arrItemId: 41,
					instanceId: "owned",
					instanceName: "private-instance",
					title: "private-title",
					service: "radarr",
					year: null,
					sizeOnDisk: 1024,
					qualityProfileName: null,
				};
				render(
					<QueryClientProvider client={client}>
						<ColorThemeProvider>
							<IncognitoProvider>
								{kind === "watched" ? (
									<WatchedMonitoredPanel
										queryData={{
											success: true,
											data: {
												hasPlexData: true,
												hasWatchData: true,
												items: [
													{
														...common,
														watchCount: 1,
														watchCountSemantics: "exact",
														lastWatchedAt: null,
													},
												],
											},
										}}
									/>
								) : (
									<DiskWastePanel
										queryData={{
											success: true,
											data: {
												hasPlexData: true,
												hasWatchData: true,
												watchStatus: "complete",
												limited: false,
												totalWastedBytes: 1024,
												unknownItems: [],
												items: [
													{
														...common,
														monitored: true,
														addedDaysAgo: 100,
														watchState: "unwatched",
													},
												],
											},
										}}
									/>
								)}
							</IncognitoProvider>
						</ColorThemeProvider>
					</QueryClientProvider>,
				);
				fireEvent.click(
					screen.getByRole("button", {
						name: kind === "watched" ? /1 watched item still monitored/i : /1 unwatched item/i,
					}),
				);
				const button = screen.getByRole("button", { name: "Unmonitor" });
				fireEvent.click(button);
				await waitFor(() => expect(calls).toHaveLength(1));
				expect(button).toBeDisabled();
				await act(async () =>
					resolve(
						status === 204
							? new Response(null, { status })
							: new Response(JSON.stringify({ error: "private-provider" }), {
									status,
									headers: { "content-type": "application/json" },
								}),
					),
				);
				expect(
					await screen.findByText(
						status === 204 ? "Monitoring disabled" : "Monitoring update not confirmed",
					),
				).toBeVisible();
				expect(calls).toEqual([
					{
						path: "/api/library/monitor",
						body: { instanceId: "owned", service: "radarr", itemId: 41, monitored: false },
					},
				]);
				expect(document.querySelector("[data-sonner-toaster]")?.textContent).not.toMatch(
					/private-title|private-instance|private-provider|owned/,
				);
				if (status !== 204)
					expect(document.querySelector('[data-sonner-toast][data-type="success"]')).toBeNull();
			},
		);
});
