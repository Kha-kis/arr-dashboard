import { webcrypto } from "node:crypto";
import type {
	ManualImportCandidate,
	ManualImportOperationStatus,
	ManualImportRemainderReview,
	ManualImportServiceType,
	ManualImportSourceStatus,
} from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { authKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { useManualImportStore } from "../../store";
import { ManualImportModal } from "../manual-import-modal";

const candidate = {
	service: "radarr",
	id: 1,
	path: "/synthetic/private-file",
	downloadId: "synthetic-source",
	movie: { id: 12, title: "Synthetic private movie" },
	quality: { quality: { id: 1 } },
};
const pending: ManualImportOperationStatus = {
	operationId: "operation-1",
	state: "pending",
	reason: null,
	selectedFileCount: 1,
	verifiedFileCount: 0,
	canConsiderNewAttempt: false,
};
let currentStatus: ManualImportOperationStatus;
let availableCandidates: ManualImportCandidate[];
let progressHttpStatus: number;
let posts: Record<string, unknown>[];
let reads: string[];
let postFailure: boolean;
let legacyStatus: ManualImportSourceStatus;
let legacyHttpStatus: number;
let legacyGate: Promise<void> | null;
let remainderReview: ManualImportRemainderReview | null;
let remainderHttpStatus: number;
let remainderGate: Promise<void> | null;
let candidateGate: Promise<void> | null;
let candidateHttpStatus: number;

beforeEach(() => {
	sessionStorage.clear();
	localStorage.clear();
	useManualImportStore.getState().clear();
	vi.stubGlobal("crypto", webcrypto);
	currentStatus = { ...pending, state: "pending" };
	availableCandidates = [{ ...candidate, service: "radarr" }];
	progressHttpStatus = 200;
	posts = [];
	reads = [];
	postFailure = false;
	legacyStatus = { kind: "none" };
	legacyHttpStatus = 200;
	legacyGate = null;
	remainderReview = null;
	remainderHttpStatus = 200;
	remainderGate = null;
	candidateGate = null;
	candidateHttpStatus = 200;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, options?: RequestInit) => {
			if (options?.method === "POST") {
				posts.push(JSON.parse(String(options.body)));
				if (postFailure) throw new Error("synthetic-private-network-error");
				return new Response(JSON.stringify(currentStatus), {
					status: 202,
					headers: { "content-type": "application/json" },
				});
			}
			reads.push(url);
			if (url.includes("/remainder")) {
				if (remainderGate) await remainderGate;
				return new Response(
					JSON.stringify(
						remainderHttpStatus === 200
							? remainderReview
							: { error: "synthetic-private-review-error" },
					),
					{ status: remainderHttpStatus, headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("/source")) {
				if (legacyGate) await legacyGate;
				return new Response(
					JSON.stringify(
						legacyHttpStatus === 200 ? legacyStatus : { error: "synthetic-private-legacy-error" },
					),
					{ status: legacyHttpStatus, headers: { "content-type": "application/json" } },
				);
			}
			const body = url.includes("/operations")
				? progressHttpStatus === 200
					? currentStatus
					: { error: "synthetic-private-error" }
				: { candidates: availableCandidates, total: availableCandidates.length };
			if (!url.includes("/operations") && candidateGate) await candidateGate;
			return new Response(JSON.stringify(body), {
				status: url.includes("/operations") ? progressHttpStatus : candidateHttpStatus,
				headers: { "content-type": "application/json" },
			});
		}),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function show(ownerId = "owner", service: ManualImportServiceType = "radarr") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	client.setQueryData(authKeys.currentUser, { id: ownerId, username: "Synthetic user" });
	const completed = vi.fn();
	const openChange = vi.fn();
	const content = (open: boolean) => (
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<ManualImportModal
						instanceId="instance"
						instanceName="Synthetic private instance"
						service={service}
						downloadId="synthetic-source"
						open={open}
						onOpenChange={openChange}
						onCompleted={completed}
					/>
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
	const view = render(content(true));
	return {
		...view,
		completed,
		openChange,
		client,
		setOpen: (open: boolean) => view.rerender(content(open)),
	};
}
async function submit() {
	await waitFor(() =>
		expect(screen.getByRole("button", { name: /Import 1 selected/i })).toBeEnabled(),
	);
	fireEvent.click(screen.getByRole("button", { name: /Import 1 selected/i }));
	await waitFor(() => expect(posts).toHaveLength(1));
}

describe("Manual Import rendered durable progress", () => {
	it("re-reviews the terminal predecessor after a retained remainder was not submitted", async () => {
		const original = { ...pending, state: "failed" as const, canConsiderNewAttempt: true };
		legacyStatus = { kind: "observed", operation: original };
		remainderReview = {
			operation: original,
			importMode: "copy",
			sourceFileCount: 1,
			sourceVerifiedFileCount: 0,
			verifiedEpisodeCount: 0,
			unavailableFileCount: 0,
			candidates: [{ ...candidate, service: "radarr" }],
		};
		const view = show();
		fireEvent.click(await screen.findByRole("button", { name: "Review remaining files" }));
		await screen.findByText("Review remaining selection");
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		currentStatus = {
			...pending,
			operationId: "unsubmitted-remainder",
			state: "not-submitted",
			reason: "not-submitted",
			canConsiderNewAttempt: true,
		};
		fireEvent.click(screen.getByRole("button", { name: "Import 1 remaining selected" }));
		await waitFor(() => expect(posts).toHaveLength(1));
		fireEvent.click(await screen.findByRole("button", { name: "Review remaining files" }));
		await screen.findByText("Review remaining selection");
		expect(screen.queryByRole("button", { name: "Review a new attempt" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		currentStatus = { ...pending, operationId: "next-remainder" };
		fireEvent.click(screen.getByRole("button", { name: "Import 1 remaining selected" }));
		await waitFor(() => expect(posts).toHaveLength(2));
		expect(posts[1]).toMatchObject({ remainderOf: "operation-1", importMode: "copy" });
		expect(posts[1]!.idempotencyKey).not.toBe(posts[0]!.idempotencyKey);
		expect(reads.filter((url) => url.includes("/remainder"))).toHaveLength(2);
		expect(
			reads
				.filter((url) => url.includes("/remainder"))
				.every((url) => url.includes("/operation-1/")),
		).toBe(true);
		expect(view.completed).not.toHaveBeenCalled();
	});
	it("reviews a retained non-submission without replacing its key until deliberate submission", async () => {
		currentStatus = {
			...pending,
			state: "not-submitted",
			reason: "not-submitted",
			canConsiderNewAttempt: true,
		};
		const view = show();
		await submit();
		const original = posts[0]!.idempotencyKey;
		const before = sessionStorage.getItem(sessionStorage.key(0)!);
		fireEvent.click(await screen.findByRole("button", { name: "Review a new attempt" }));
		await screen.findByText("Review new import attempt");
		expect(screen.getByRole("button", { name: "Import selected" })).toBeDisabled();
		expect(posts).toHaveLength(1);
		expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(before);
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		currentStatus = { ...pending, operationId: "operation-2" };
		fireEvent.click(await screen.findByRole("button", { name: "Import 1 selected" }));
		await waitFor(() => expect(posts).toHaveLength(2));
		expect(posts[1]!.idempotencyKey).not.toBe(original);
		expect(posts[1]).not.toHaveProperty("remainderOf");
		await screen.findByRole("button", { name: "Check progress" });
		expect(view.completed).not.toHaveBeenCalled();
		view.unmount();
		show();
		await screen.findByRole("button", { name: "Check progress" });
		expect(posts).toHaveLength(2);
		expect(reads.some((url) => url.includes(String(posts[1]!.idempotencyKey)))).toBe(true);
	});
	it.each(["sonarr", "radarr", "lidarr", "readarr"] as const)(
		"requires explicit selection for a discovered non-submitted %s attempt",
		async (service) => {
			const media =
				service === "sonarr"
					? { series: { id: 12 }, episodes: [{ id: 13 }] }
					: service === "radarr"
						? { movie: { id: 12 } }
						: service === "lidarr"
							? { artist: { id: 12 }, album: { id: 13 } }
							: { author: { id: 12 }, book: { id: 13 } };
			availableCandidates = [{ ...candidate, service, ...media }];
			legacyStatus = {
				kind: "observed",
				operation: {
					...pending,
					state: "not-submitted",
					reason: "not-submitted",
					canConsiderNewAttempt: true,
				},
			};
			const view = show("owner", service);
			const review = await screen.findByRole("button", { name: "Review a new attempt" });
			expect(reads.some((url) => url.startsWith("/api/manual-import?"))).toBe(false);
			fireEvent.click(review);
			await screen.findByText("Review new import attempt");
			expect(screen.getByRole("button", { name: "Import selected" })).toBeDisabled();
			expect(posts).toHaveLength(0);
			expect(sessionStorage.length).toBe(0);
			fireEvent.click(screen.getByRole("button", { name: "Select All" }));
			fireEvent.click(await screen.findByRole("button", { name: "Import 1 selected" }));
			await waitFor(() => expect(posts).toHaveLength(1));
			expect(posts[0]).toMatchObject({ service });
			expect(posts[0]).not.toHaveProperty("remainderOf");
			await screen.findByRole("button", { name: "Check progress" });
			expect(view.completed).not.toHaveBeenCalled();
		},
	);
	it("cancels a new-attempt review without discarding retained non-submission", async () => {
		currentStatus = {
			...pending,
			state: "not-submitted",
			reason: "not-submitted",
			canConsiderNewAttempt: true,
		};
		show();
		await submit();
		const retained = sessionStorage.getItem(sessionStorage.key(0)!);
		fireEvent.click(await screen.findByRole("button", { name: "Review a new attempt" }));
		await screen.findByText("Review new import attempt");
		fireEvent.click(screen.getByRole("button", { name: "Back to progress" }));
		await screen.findByRole("button", { name: "Review a new attempt" });
		expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(retained);
		expect(posts).toHaveLength(1);
	});
	it("does not unlock new work on failed candidate review", async () => {
		legacyStatus = {
			kind: "observed",
			operation: {
				...pending,
				state: "not-submitted",
				reason: "not-submitted",
				canConsiderNewAttempt: true,
			},
		};
		candidateHttpStatus = 503;
		show();
		fireEvent.click(await screen.findByRole("button", { name: "Review a new attempt" }));
		await screen.findByText(/New-attempt review is unavailable/);
		expect(screen.queryByText("Review new import attempt")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Check progress" })).toBeEnabled();
		expect(posts).toHaveLength(0);
		expect(sessionStorage.length).toBe(0);
	});
	it("rejects wrong-service candidates rather than opening a misleading new review", async () => {
		legacyStatus = {
			kind: "observed",
			operation: {
				...pending,
				state: "not-submitted",
				reason: "not-submitted",
				canConsiderNewAttempt: true,
			},
		};
		availableCandidates = [
			{ ...candidate, service: "sonarr", series: { id: 12 }, episodes: [{ id: 13 }] },
		];
		show();
		fireEvent.click(await screen.findByRole("button", { name: "Review a new attempt" }));
		await screen.findByText(/New-attempt review is unavailable/);
		expect(screen.queryByText("Review new import attempt")).not.toBeInTheDocument();
		expect(posts).toHaveLength(0);
		expect(sessionStorage.length).toBe(0);
	});
	it("does not replace an attempt changed while a new review was being selected", async () => {
		currentStatus = {
			...pending,
			state: "not-submitted",
			reason: "not-submitted",
			canConsiderNewAttempt: true,
		};
		show();
		await submit();
		fireEvent.click(await screen.findByRole("button", { name: "Review a new attempt" }));
		await screen.findByText("Review new import attempt");
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		const key = sessionStorage.key(0)!;
		const changed = {
			...JSON.parse(sessionStorage.getItem(key)!),
			idempotencyKey: "another-retained-attempt",
		};
		sessionStorage.setItem(key, JSON.stringify(changed));
		fireEvent.click(screen.getByRole("button", { name: "Import 1 selected" }));
		await screen.findByText(/retained attempt changed since review/);
		expect(posts).toHaveLength(1);
		expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(changed);
	});
	it("keeps a lost new-attempt acknowledgement bound to the distinct retained key", async () => {
		currentStatus = {
			...pending,
			state: "not-submitted",
			reason: "not-submitted",
			canConsiderNewAttempt: true,
		};
		const view = show();
		await submit();
		fireEvent.click(await screen.findByRole("button", { name: "Review a new attempt" }));
		await screen.findByText("Review new import attempt");
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		postFailure = true;
		currentStatus = { ...pending, operationId: "operation-2" };
		fireEvent.click(screen.getByRole("button", { name: "Import 1 selected" }));
		await waitFor(() => expect(posts).toHaveLength(2));
		await screen.findByRole("button", { name: "Check progress" });
		expect(posts[1]!.idempotencyKey).not.toBe(posts[0]!.idempotencyKey);
		expect(JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!).idempotencyKey).toBe(
			posts[1]!.idempotencyKey,
		);
		view.unmount();
		const reopened = show();
		await screen.findByRole("button", { name: "Check progress" });
		expect(reads.some((url) => url.includes(String(posts[1]!.idempotencyKey)))).toBe(true);
		expect(posts).toHaveLength(2);
		expect(reopened.completed).not.toHaveBeenCalled();
	});
	it("rejects a silent storage failure before new-attempt POST", async () => {
		currentStatus = {
			...pending,
			state: "not-submitted",
			reason: "not-submitted",
			canConsiderNewAttempt: true,
		};
		show();
		await submit();
		const retained = sessionStorage.getItem(sessionStorage.key(0)!);
		fireEvent.click(await screen.findByRole("button", { name: "Review a new attempt" }));
		await screen.findByText("Review new import attempt");
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
		fireEvent.click(screen.getByRole("button", { name: "Import 1 selected" }));
		await screen.findByText(/Browser attempt storage is unavailable/);
		expect(posts).toHaveLength(1);
		expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(retained);
	});
	it("does not install a late new-attempt review after close and reopen", async () => {
		legacyStatus = {
			kind: "observed",
			operation: {
				...pending,
				state: "not-submitted",
				reason: "not-submitted",
				canConsiderNewAttempt: true,
			},
		};
		let release!: () => void;
		candidateGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const view = show();
		fireEvent.click(await screen.findByRole("button", { name: "Review a new attempt" }));
		await waitFor(() =>
			expect(reads.some((url) => url.startsWith("/api/manual-import?"))).toBe(true),
		);
		view.setOpen(false);
		view.setOpen(true);
		release();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Review a new attempt" })).toBeEnabled(),
		);
		expect(screen.queryByText("Review new import attempt")).not.toBeInTheDocument();
		expect(posts).toHaveLength(0);
		expect(sessionStorage.length).toBe(0);
	});
	it("retains a new key after a lost remainder acknowledgement and reloads by GET only", async () => {
		const view = show();
		await submit();
		await screen.findByText("0 of 1 files verified.");
		const originalKey = posts[0]?.idempotencyKey;
		currentStatus = { ...pending, state: "failed", canConsiderNewAttempt: true };
		fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
		const review = await screen.findByRole("button", { name: "Review remaining files" });
		remainderReview = {
			operation: currentStatus,
			importMode: "move",
			sourceFileCount: 1,
			sourceVerifiedFileCount: 0,
			verifiedEpisodeCount: 0,
			unavailableFileCount: 0,
			candidates: [{ ...candidate, service: "radarr" }],
		};
		fireEvent.click(review);
		await screen.findByText("Review remaining selection");
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		currentStatus = { ...pending, operationId: "new-operation" };
		postFailure = true;
		fireEvent.click(screen.getByRole("button", { name: "Import 1 remaining selected" }));
		await waitFor(() => expect(posts).toHaveLength(2));
		await screen.findByText(/Import response is unavailable/);
		expect(posts[1]?.idempotencyKey).not.toBe(originalKey);
		expect(posts[1]).toMatchObject({ remainderOf: "operation-1" });
		const newKey = String(posts[1]?.idempotencyKey);
		expect(JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!).idempotencyKey).toBe(newKey);
		view.unmount();
		view.client.clear();
		const recovered = show();
		await screen.findByText("0 of 1 files verified.");
		fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
		await waitFor(() =>
			expect(
				reads.filter((url) => url.includes("idempotencyKey=" + newKey)).length,
			).toBeGreaterThan(1),
		);
		expect(posts).toHaveLength(2);
		expect(reads.filter((url) => url.includes("/remainder"))).toHaveLength(1);
		expect(recovered.completed).not.toHaveBeenCalled();
	});
	it("blocks a new remainder request when storage cannot replace the original key", async () => {
		show();
		await submit();
		await screen.findByText("0 of 1 files verified.");
		const retained = sessionStorage.getItem(sessionStorage.key(0)!);
		currentStatus = { ...pending, state: "failed", canConsiderNewAttempt: true };
		fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
		remainderReview = {
			operation: currentStatus,
			importMode: "move",
			sourceFileCount: 1,
			sourceVerifiedFileCount: 0,
			verifiedEpisodeCount: 0,
			unavailableFileCount: 0,
			candidates: [{ ...candidate, service: "radarr" }],
		};
		fireEvent.click(await screen.findByRole("button", { name: "Review remaining files" }));
		await screen.findByText("Review remaining selection");
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => undefined);
		fireEvent.click(screen.getByRole("button", { name: "Import 1 remaining selected" }));
		await screen.findByText(/Browser attempt storage is unavailable/);
		expect(posts).toHaveLength(1);
		expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(retained);
	});
	it("does not turn unavailable original targets into imported success or a new request", async () => {
		const original = { ...pending, state: "failed" as const, canConsiderNewAttempt: true };
		legacyStatus = { kind: "observed", operation: original };
		remainderReview = {
			operation: original,
			importMode: "move",
			sourceFileCount: 1,
			sourceVerifiedFileCount: 0,
			verifiedEpisodeCount: 0,
			unavailableFileCount: 1,
			candidates: [],
		};
		const view = show();
		fireEvent.click(await screen.findByRole("button", { name: "Review remaining files" }));
		await screen.findByText(
			/0 of 1 original source files verified; 0 available for review; 1 unavailable/,
		);
		expect(screen.getByRole("button", { name: "Import remaining selected" })).toBeDisabled();
		expect(view.completed).not.toHaveBeenCalled();
		expect(posts).toHaveLength(0);
	});
	it("does not apply a late provider review after closing and reopening", async () => {
		const original = { ...pending, state: "failed" as const, canConsiderNewAttempt: true };
		legacyStatus = { kind: "observed", operation: original };
		remainderReview = {
			operation: original,
			importMode: "move",
			sourceFileCount: 1,
			sourceVerifiedFileCount: 0,
			verifiedEpisodeCount: 0,
			unavailableFileCount: 0,
			candidates: [{ ...candidate, service: "radarr" }],
		};
		let release!: () => void;
		remainderGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const view = show();
		fireEvent.click(await screen.findByRole("button", { name: "Review remaining files" }));
		await waitFor(() => expect(reads.some((url) => url.includes("/remainder"))).toBe(true));
		view.setOpen(false);
		view.setOpen(true);
		release();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Review remaining files" })).toBeEnabled(),
		);
		expect(screen.queryByText("Review remaining selection")).not.toBeInTheDocument();
		expect(posts).toHaveLength(0);
		expect(sessionStorage.length).toBe(0);
	});
	it.each(["sonarr", "radarr", "lidarr", "readarr"] as const)(
		"requires explicit review and selection before a new %s remainder command",
		async (service) => {
			const media =
				service === "sonarr"
					? {
							series: { id: 12, title: "Synthetic private series" },
							episodes: [{ id: 14, title: "Synthetic remaining episode" }],
						}
					: service === "radarr"
						? { movie: { id: 12, title: "Synthetic private movie" } }
						: service === "lidarr"
							? { artist: { id: 12 }, album: { id: 13 } }
							: { author: { id: 12 }, book: { id: 13 } };
			const original = {
				...pending,
				state: "partial" as const,
				selectedFileCount: 2,
				verifiedFileCount: 1,
				canConsiderNewAttempt: true,
			};
			legacyStatus = { kind: "observed", operation: original };
			remainderReview = {
				operation: original,
				importMode: "copy",
				sourceFileCount: 2,
				sourceVerifiedFileCount: 1,
				verifiedEpisodeCount: service === "sonarr" ? 1 : 0,
				unavailableFileCount: 0,
				candidates: [{ ...candidate, service, ...media }],
			};
			const view = show("owner", service);
			const review = await screen.findByRole("button", { name: "Review remaining files" });
			expect(reads.some((url) => url.includes("/remainder"))).toBe(false);
			fireEvent.click(review);
			await screen.findByText("Review remaining selection");
			expect(posts).toHaveLength(0);
			expect(screen.getByRole("combobox")).toHaveValue("copy");
			expect(screen.getByRole("combobox")).toBeDisabled();
			expect(screen.getByRole("button", { name: /Import remaining selected/ })).toBeDisabled();
			fireEvent.click(screen.getByRole("button", { name: "Select All" }));
			const submit = screen.getByRole("button", { name: /Import 1 remaining selected/ });
			await waitFor(() => expect(submit).toBeEnabled());
			fireEvent.click(submit);
			await waitFor(() => expect(posts).toHaveLength(1));
			expect(posts[0]).toMatchObject({ remainderOf: "operation-1", importMode: "copy" });
			if (service === "sonarr")
				expect(posts[0]?.files).toEqual([expect.objectContaining({ episodeIds: [14] })]);
			await screen.findByText("0 of 1 files verified.");
			expect(view.completed).not.toHaveBeenCalled();
			expect(view.openChange).not.toHaveBeenCalled();
			const retained = JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!);
			expect(retained).toMatchObject({
				version: 2,
				remainderOf: "operation-1",
				idempotencyKey: posts[0]?.idempotencyKey,
			});
			expect(JSON.stringify(retained)).not.toMatch(
				/private-file|synthetic-source|Synthetic private/,
			);
			view.unmount();
			view.client.clear();
			show("owner", service);
			await screen.findByText("0 of 1 files verified.");
			fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
			await waitFor(() =>
				expect(reads.filter((url) => url.includes("/operations?")).length).toBeGreaterThan(1),
			);
			expect(posts).toHaveLength(1);
			expect(reads.filter((url) => url.includes("/remainder"))).toHaveLength(1);
		},
	);
	it("cancels an unsent review without replacing the retained original attempt", async () => {
		const view = show();
		await submit();
		await screen.findByText("0 of 1 files verified.");
		const originalKey = posts[0]?.idempotencyKey;
		currentStatus = { ...pending, state: "failed", canConsiderNewAttempt: true };
		fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
		const review = await screen.findByRole("button", { name: "Review remaining files" });
		remainderReview = {
			operation: currentStatus,
			importMode: "move",
			sourceFileCount: 1,
			sourceVerifiedFileCount: 0,
			verifiedEpisodeCount: 0,
			unavailableFileCount: 0,
			candidates: [{ ...candidate, service: "radarr" }],
		};
		fireEvent.click(review);
		await screen.findByText("Review remaining selection");
		fireEvent.click(screen.getByRole("button", { name: "Back to progress" }));
		await screen.findByRole("button", { name: "Review remaining files" });
		expect(JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!).idempotencyKey).toBe(
			originalKey,
		);
		expect(posts).toHaveLength(1);
		expect(view.completed).not.toHaveBeenCalled();
	});
	it("contains a failed remaining review without offering stale candidates or submitting", async () => {
		legacyStatus = {
			kind: "observed",
			operation: { ...pending, state: "failed", canConsiderNewAttempt: true },
		};
		remainderHttpStatus = 503;
		show();
		fireEvent.click(await screen.findByRole("button", { name: "Review remaining files" }));
		await screen.findByText(/Remaining-file review is unavailable/);
		expect(
			screen.queryByRole("button", { name: /Import.*remaining selected/ }),
		).not.toBeInTheDocument();
		expect(screen.queryByText(/synthetic-private-review-error/)).not.toBeInTheDocument();
		expect(posts).toHaveLength(0);
		expect(sessionStorage.length).toBe(0);
	});
	it.each(["sonarr", "radarr", "lidarr", "readarr"] as const)(
		"lists distinct %s history and inspects only an explicit selection",
		async (service) => {
			legacyStatus = {
				kind: "history",
				operations: [
					{
						...pending,
						operationId: "historical-complete",
						state: "completed",
						selectedFileCount: 2,
						verifiedFileCount: 2,
					},
					{
						...pending,
						operationId: "historical-partial",
						state: "partial",
						selectedFileCount: 3,
						verifiedFileCount: 1,
						canConsiderNewAttempt: true,
					},
				],
				nextCursor: null,
			};
			const view = show("owner", service);
			await screen.findByText("Recorded import attempts");
			expect(screen.queryByText("All selected files verified")).not.toBeInTheDocument();
			expect(screen.queryByText("Import partially verified")).not.toBeInTheDocument();
			const inspect = screen.getByRole("button", { name: "Inspect recorded attempt 2" });
			inspect.focus();
			fireEvent.click(inspect);
			await screen.findByText("Import partially verified");
			await screen.findByText("1 of 3 files verified.");
			expect(inspect).toHaveFocus();
			expect(posts).toHaveLength(0);
			expect(view.completed).not.toHaveBeenCalled();
			expect(sessionStorage.length).toBe(0);
			expect(reads.every((url) => url.includes("/source"))).toBe(true);
		},
	);
	it("keeps cached inspection keyboard-accessible during a background read", async () => {
		legacyStatus = { kind: "history", operations: [{ ...pending }], nextCursor: null };
		show();
		const inspect = await screen.findByRole("button", { name: "Inspect recorded attempt 1" });
		inspect.focus();
		let release!: () => void;
		legacyGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
			await waitFor(() => expect(reads.length).toBeGreaterThan(1));
			expect(inspect).toBeEnabled();
			expect(inspect).toHaveFocus();
			const check = screen.getByRole("button", { name: "Check progress" });
			expect(check).toBeEnabled();
			check.focus();
			const before = reads.length;
			fireEvent.click(check);
			expect(reads).toHaveLength(before);
			expect(check).toHaveFocus();
		} finally {
			release();
			legacyGate = null;
		}
	});
	it("hands off focus when unavailable evidence disables the inspected history control", async () => {
		legacyStatus = { kind: "history", operations: [{ ...pending }], nextCursor: null };
		show();
		const inspect = await screen.findByRole("button", { name: "Inspect recorded attempt 1" });
		inspect.focus();
		fireEvent.click(inspect);
		legacyHttpStatus = 503;
		// A background refresh need not originate from the currently focused control.
		fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
		await screen.findByText("Cached progress unavailable");
		expect(inspect).toBeDisabled();
		expect(screen.getByRole("button", { name: "Close modal" })).toHaveFocus();
	});
	it("paginates without carrying selected counts, blocks unavailable pages, and recovers to an active claim", async () => {
		legacyStatus = {
			kind: "history",
			operations: [{ ...pending, operationId: "first-page" }],
			nextCursor: "first-page",
		};
		const view = show();
		await screen.findByRole("button", { name: "Inspect recorded attempt 1" });
		fireEvent.click(screen.getByRole("button", { name: "Inspect recorded attempt 1" }));
		await screen.findByText("0 of 1 files verified.");
		legacyStatus = {
			kind: "history",
			operations: [{ ...pending, operationId: "second-page", selectedFileCount: 4 }],
			nextCursor: null,
		};
		const next = screen.getByRole("button", { name: "Next attempts" });
		next.focus();
		fireEvent.click(next);
		await waitFor(() => expect(reads.some((url) => url.includes("cursor=first-page"))).toBe(true));
		await screen.findByText("Recorded import attempts");
		expect(screen.getByRole("button", { name: "Close modal" })).toHaveFocus();
		expect(screen.queryByText("0 of 1 files verified.")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Inspect recorded attempt 1" }));
		await screen.findByText("0 of 4 files verified.");
		legacyHttpStatus = 503;
		fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
		await screen.findByText("Cached progress unavailable");
		await screen.findByText("0 of 4 files verified in the last available observation.");
		expect(screen.getByRole("button", { name: "Previous attempts" })).toBeDisabled();
		expect(screen.getByRole("button", { name: "Inspect recorded attempt 1" })).toBeDisabled();
		legacyHttpStatus = 200;
		legacyStatus = {
			kind: "observed",
			operation: { ...pending, operationId: "current-claim", selectedFileCount: 7 },
		};
		fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
		await screen.findByText("0 of 7 files verified.");
		expect(
			screen.queryByRole("button", { name: "Inspect recorded attempt 1" }),
		).not.toBeInTheDocument();
		expect(posts).toHaveLength(0);
		expect(view.completed).not.toHaveBeenCalled();
		expect(sessionStorage.length).toBe(0);
	});
	it.each(["sonarr", "radarr", "lidarr", "readarr"] as const)(
		"recovers %s work from another session or automatic worker rather than presenting a new import",
		async (service) => {
			const previousFetch = vi.mocked(fetch).getMockImplementation()!;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, options?: RequestInit) => {
					if (url.includes("/source")) {
						reads.push(url);
						return new Response(
							JSON.stringify({ kind: "observed", operation: { ...pending, selectedFileCount: 3 } }),
							{ status: 200, headers: { "content-type": "application/json" } },
						);
					}
					return previousFetch(url, options);
				}),
			);
			const view = show("owner", service);
			await screen.findByText("0 of 3 files verified.");
			expect(
				reads.every((url) => url.includes("/source") && url.includes(`service=${service}`)),
			).toBe(true);
			expect(screen.queryByRole("button", { name: /Import.*selected/i })).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
			await waitFor(() => expect(reads.length).toBeGreaterThan(1));
			expect(posts).toHaveLength(0);
			expect(view.completed).not.toHaveBeenCalled();
			expect(sessionStorage.length).toBe(0);
		},
	);
	it.each(["sonarr", "radarr", "lidarr", "readarr"] as const)(
		"observes recovered %s work privately without candidate reads",
		async (service) => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			legacyStatus = {
				kind: "observed",
				operation: { ...pending, state: "pending", selectedFileCount: 2 },
			};
			const view = show("owner", service);
			await screen.findByText("0 of 2 files verified.");
			expect(
				reads.every((url) => url.includes("/source") && url.includes(`service=${service}`)),
			).toBe(true);
			expect(screen.queryAllByText(/Synthetic private|synthetic-source|private-file/)).toHaveLength(
				0,
			);
			fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Check progress" })).toBeEnabled(),
			);
			expect(posts).toHaveLength(0);
			expect(view.completed).not.toHaveBeenCalled();
		},
	);
	it.each([
		{ state: "pending" as const, verifiedFileCount: 0 },
		{ state: "unknown" as const, verifiedFileCount: 0 },
		{ state: "failed" as const, verifiedFileCount: 0 },
		{ state: "partial" as const, verifiedFileCount: 1 },
		{ state: "completed" as const, verifiedFileCount: 2 },
	])(
		"displays recovered $state legacy evidence without candidates or a new request",
		async ({ state, verifiedFileCount }) => {
			legacyStatus = {
				kind: "observed",
				operation: {
					...pending,
					state,
					selectedFileCount: 2,
					verifiedFileCount,
					canConsiderNewAttempt: state === "partial" || state === "failed",
				},
			};
			const view = show();
			await screen.findByText(`${verifiedFileCount} of 2 files verified.`);
			const check = screen.getByRole("button", { name: "Check progress" });
			await waitFor(() => expect(check).toBeEnabled());
			const before = reads.filter((url) => url.includes("/source")).length;
			fireEvent.click(check);
			await waitFor(() =>
				expect(reads.filter((url) => url.includes("/source")).length).toBeGreaterThan(before),
			);
			expect(reads.every((url) => url.includes("/source"))).toBe(true);
			expect(posts).toHaveLength(0);
			expect(view.completed).not.toHaveBeenCalled();
			expect(screen.queryByRole("button", { name: /Import.*selected/i })).not.toBeInTheDocument();
			view.setOpen(false);
			view.setOpen(true);
			await screen.findByText(`${verifiedFileCount} of 2 files verified.`);
			expect(posts).toHaveLength(0);
		},
	);
	it("waits for legacy lookup before selecting or requesting files", async () => {
		let release!: () => void;
		legacyGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		show();
		await waitFor(() => expect(reads.some((url) => url.includes("/source"))).toBe(true));
		expect(reads.every((url) => url.includes("/source"))).toBe(true);
		expect(posts).toHaveLength(0);
		expect(screen.queryByRole("button", { name: /Import.*selected/i })).not.toBeInTheDocument();
		release();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /Import 1 selected/i })).toBeEnabled(),
		);
		expect(posts).toHaveLength(0);
	});
	it("shows unavailable legacy evidence without invented counts and recovers with GET only", async () => {
		legacyStatus = { kind: "unavailable", reason: "evidence-unavailable" };
		const view = show();
		await screen.findByText("Existing import evidence unavailable");
		expect(screen.queryByText(/files verified/)).not.toBeInTheDocument();
		legacyStatus = {
			kind: "observed",
			operation: { ...pending, state: "pending", selectedFileCount: 2 },
		};
		fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
		await screen.findByText("0 of 2 files verified.");
		expect(posts).toHaveLength(0);
		expect(view.completed).not.toHaveBeenCalled();
	});
	it("labels a failed legacy status read and preserves prior factual counts without replay", async () => {
		legacyStatus = {
			kind: "observed",
			operation: { ...pending, state: "pending", selectedFileCount: 2 },
		};
		const view = show();
		await screen.findByText("0 of 2 files verified.");
		legacyHttpStatus = 503;
		fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
		await screen.findByText("Cached progress unavailable");
		expect(screen.getByText(/last available observation/)).toBeInTheDocument();
		expect(screen.queryByText(/synthetic-private-legacy-error/)).not.toBeInTheDocument();
		legacyHttpStatus = 200;
		legacyStatus = {
			kind: "observed",
			operation: { ...pending, state: "completed", verifiedFileCount: 1 },
		};
		fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
		await screen.findByText("1 of 1 files verified.");
		expect(posts).toHaveLength(0);
		expect(view.completed).not.toHaveBeenCalled();
	});
	it("does not offer original-key retry when not-found recovers existing legacy work", async () => {
		postFailure = true;
		progressHttpStatus = 404;
		const first = show();
		await submit();
		first.unmount();
		first.client.clear();
		legacyStatus = {
			kind: "observed",
			operation: { ...pending, state: "pending", selectedFileCount: 2 },
		};
		show();
		await screen.findByText("0 of 2 files verified.");
		expect(
			screen.queryByRole("button", { name: "Retry original request" }),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Check progress" })).toBeEnabled(),
		);
		expect(posts).toHaveLength(1);
	});
	it("prefers the valid retained attempt over unrelated historical legacy progress", async () => {
		const first = show();
		await submit();
		first.unmount();
		first.client.clear();
		reads = [];
		legacyStatus = {
			kind: "observed",
			operation: { ...pending, state: "pending", selectedFileCount: 2 },
		};
		show();
		await screen.findByText("0 of 1 files verified.");
		expect(reads.some((url) => url.includes("/source"))).toBe(false);
		expect(posts).toHaveLength(1);
	});
	it("keeps pending visible without reporting imported files or closing", async () => {
		const view = show();
		await submit();
		await waitFor(() => expect(screen.getByText(/0 of 1 files verified/i)).toBeInTheDocument());
		expect(view.completed).not.toHaveBeenCalled();
		expect(view.openChange).not.toHaveBeenCalled();
		expect(posts[0]).toHaveProperty("idempotencyKey");
		expect(screen.getByRole("button", { name: /Check progress/i })).toBeEnabled();
	});
	it("recovers a lost response after reload using only cached reads", async () => {
		postFailure = true;
		const first = show();
		await submit();
		await waitFor(() =>
			expect(screen.getByText(/outcome.*unavailable|response.*unavailable/i)).toBeInTheDocument(),
		);
		expect(screen.queryByText(/synthetic-private-network-error/)).not.toBeInTheDocument();
		const key = posts[0]?.idempotencyKey;
		expect(typeof key).toBe("string");
		first.unmount();
		first.client.clear();
		const second = show();
		await waitFor(() => expect(screen.getByText(/0 of 1 files verified/i)).toBeInTheDocument());
		expect(posts).toHaveLength(1);
		expect(reads.some((url) => url.includes("/operations") && url.includes(String(key)))).toBe(
			true,
		);
		expect(second.completed).not.toHaveBeenCalled();
		const stored = Array.from({ length: sessionStorage.length }, (_, index) => [
			sessionStorage.key(index),
			sessionStorage.getItem(sessionStorage.key(index)!),
		]);
		expect(JSON.stringify(stored)).not.toMatch(
			/synthetic-source|private-file|private instance|private movie/,
		);
	});
	it("refreshes verified completion without another POST", async () => {
		const view = show();
		await submit();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /Check progress/i })).toBeEnabled(),
		);
		currentStatus = { ...pending, state: "completed", verifiedFileCount: 1 };
		fireEvent.click(screen.getByRole("button", { name: /Check progress/i }));
		await waitFor(() => expect(screen.getByText(/1 of 1 files verified/i)).toBeInTheDocument());
		expect(view.completed).toHaveBeenCalledWith({ status: "success", imported: 1 });
		expect(posts).toHaveLength(1);
	});
	it("does not load another owner's retained attempt", async () => {
		const first = show();
		await submit();
		await waitFor(() => expect(screen.getByText(/0 of 1 files verified/i)).toBeInTheDocument());
		first.unmount();
		first.client.clear();
		reads = [];
		show("other-owner");
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /Import 1 selected/i })).toBeEnabled(),
		);
		expect(reads.some((url) => url.includes("/operations"))).toBe(false);
	});
	it("conceals the existing candidate and connection fields in incognito mode", async () => {
		localStorage.setItem("arr-dashboard-incognito-mode", "true");
		show();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /Import 1 selected/i })).toBeEnabled(),
		);
		expect(screen.queryAllByText(/Synthetic private|synthetic-source|private-file/)).toHaveLength(
			0,
		);
	});
	it("blocks submission when retained storage becomes corrupt before reopening", async () => {
		const view = show();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /Import 1 selected/i })).toBeEnabled(),
		);
		view.setOpen(false);
		const key = `arr-import-attempt:v1:${Buffer.from(await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["owner", "instance", "radarr", "synthetic-source", null])))).toString("hex")}`;
		sessionStorage.setItem(key, "corrupt");
		view.setOpen(true);
		await waitFor(() =>
			expect(screen.getByText(/Browser attempt recovery is unavailable/i)).toBeInTheDocument(),
		);
		expect(screen.getByRole("button", { name: /Import .*selected/i })).toBeDisabled();
		expect(posts).toHaveLength(0);
	});
	it("blocks the provider request when storage cannot retain the attempt", async () => {
		show();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /Import 1 selected/i })).toBeEnabled(),
		);
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("synthetic-private-storage-error");
		});
		fireEvent.click(screen.getByRole("button", { name: /Import 1 selected/i }));
		await waitFor(() =>
			expect(screen.getByText(/Browser attempt storage is unavailable/i)).toBeInTheDocument(),
		);
		expect(posts).toHaveLength(0);
		expect(screen.queryByText(/synthetic-private-storage-error/)).not.toBeInTheDocument();
	});
	it("keeps genuine partial file proof visible without completion", async () => {
		availableCandidates = [
			{ ...candidate, service: "radarr" },
			{
				...candidate,
				service: "radarr",
				id: 2,
				path: "/synthetic/second-file",
				movie: { id: 13, title: "Synthetic second movie" },
			},
		];
		currentStatus = {
			...currentStatus,
			state: "partial",
			selectedFileCount: 2,
			verifiedFileCount: 1,
			canConsiderNewAttempt: true,
		};
		const view = show();
		await waitFor(() => expect(screen.getByRole("button", { name: "Select All" })).toBeEnabled());
		fireEvent.click(screen.getByRole("button", { name: "Select All" }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /Import 2 selected/i })).toBeEnabled(),
		);
		fireEvent.click(screen.getByRole("button", { name: /Import 2 selected/i }));
		await waitFor(() => expect(screen.getByText(/1 of 2 files verified/i)).toBeInTheDocument());
		expect(posts[0]?.files).toHaveLength(2);
		expect(view.completed).not.toHaveBeenCalled();
		expect(view.openChange).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: /Check progress/i }));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /Check progress/i })).toBeEnabled(),
		);
		expect(posts).toHaveLength(1);
	});
	it.each(["unknown", "failed", "not-submitted"] as const)(
		"does not turn %s into successful import",
		async (state) => {
			currentStatus = {
				...currentStatus,
				state,
				reason: state === "not-submitted" ? "not-submitted" : "evidence-unavailable",
			};
			const view = show();
			await submit();
			await waitFor(() => expect(screen.getByText(/0 of 1 files verified/i)).toBeInTheDocument());
			expect(view.completed).not.toHaveBeenCalled();
			expect(screen.getByRole("button", { name: /Check progress/i })).toBeEnabled();
		},
	);
	it("labels stale cached progress unavailable and recovers with GET only", async () => {
		const view = show();
		await submit();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: /Check progress/i })).toBeEnabled(),
		);
		progressHttpStatus = 503;
		fireEvent.click(screen.getByRole("button", { name: /Check progress/i }));
		await waitFor(() =>
			expect(screen.getByText("Cached progress unavailable")).toBeInTheDocument(),
		);
		expect(screen.getByText(/last available observation/)).toBeInTheDocument();
		expect(screen.queryByText(/synthetic-private-error/)).not.toBeInTheDocument();
		expect(view.completed).not.toHaveBeenCalled();
		progressHttpStatus = 200;
		currentStatus = { ...currentStatus, state: "completed", verifiedFileCount: 1 };
		fireEvent.click(screen.getByRole("button", { name: /Check progress/i }));
		await waitFor(() =>
			expect(view.completed).toHaveBeenCalledWith({ status: "success", imported: 1 }),
		);
		expect(posts).toHaveLength(1);
	});
	it("offers an explicit same-key original-request retry only after cached not-found", async () => {
		postFailure = true;
		progressHttpStatus = 404;
		const first = show();
		await submit();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Retry original request" })).toBeEnabled(),
		);
		const key = posts[0]?.idempotencyKey;
		first.unmount();
		first.client.clear();
		show();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Retry original request" })).toBeEnabled(),
		);
		expect(posts).toHaveLength(1);
		expect(screen.getByRole("button", { name: "Check progress" })).toBeEnabled();
		postFailure = false;
		progressHttpStatus = 200;
		fireEvent.click(screen.getByRole("button", { name: "Retry original request" }));
		await waitFor(() => expect(screen.getByText(/0 of 1 files verified/i)).toBeInTheDocument());
		expect(posts).toHaveLength(2);
		expect(posts[1]?.idempotencyKey).toBe(key);
	});
	it("does not submit a changed candidate under a retained key after not-found", async () => {
		postFailure = true;
		progressHttpStatus = 404;
		const first = show();
		await submit();
		first.unmount();
		first.client.clear();
		availableCandidates = [
			{ ...candidate, service: "radarr", movie: { id: 99, title: "Synthetic changed movie" } },
		];
		show();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Retry original request" })).toBeEnabled(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Retry original request" }));
		await waitFor(() =>
			expect(screen.getByText(/selection differs from the retained attempt/i)).toBeInTheDocument(),
		);
		expect(posts).toHaveLength(1);
	});
	it.each([
		{
			service: "sonarr" as const,
			mapping: {
				series: { id: 12, title: "Synthetic private series" },
				episodes: [{ id: 13, title: "Synthetic private episode" }],
			},
			expected: { seriesId: 12, episodeIds: [13] },
		},
		{
			service: "radarr" as const,
			mapping: { movie: { id: 12, title: "Synthetic private movie" } },
			expected: { movieId: 12 },
		},
		{
			service: "lidarr" as const,
			mapping: {
				artist: { id: 12, artistName: "Synthetic private artist" },
				album: { id: 13, title: "Synthetic private album" },
			},
			expected: { artistId: 12, albumId: 13 },
		},
		{
			service: "readarr" as const,
			mapping: {
				author: { id: 12, authorName: "Synthetic private author" },
				book: { id: 13, title: "Synthetic private book" },
			},
			expected: { authorId: 12, bookId: 13 },
		},
	])(
		"retains truthful private-safe progress for $service",
		async ({ service, mapping, expected }) => {
			localStorage.setItem("arr-dashboard-incognito-mode", "true");
			availableCandidates = [{ ...candidate, ...mapping, service }];
			const view = show("owner", service);
			await waitFor(() =>
				expect(screen.getByRole("button", { name: /Import 1 selected/i })).toBeEnabled(),
			);
			expect(screen.queryAllByText(/Synthetic private|synthetic-source|private-file/)).toHaveLength(
				0,
			);
			await submit();
			await waitFor(() => expect(screen.getByText(/0 of 1 files verified/i)).toBeInTheDocument());
			expect(posts[0]?.service).toBe(service);
			expect(posts[0]?.files).toEqual([expect.objectContaining(expected)]);
			expect(view.completed).not.toHaveBeenCalled();
			currentStatus = { ...currentStatus, state: "completed", verifiedFileCount: 1 };
			fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
			await waitFor(() =>
				expect(view.completed).toHaveBeenCalledWith({ status: "success", imported: 1 }),
			);
			expect(posts).toHaveLength(1);
		},
	);
});
