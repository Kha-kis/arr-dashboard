import { webcrypto } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ManualImportOperationStatus } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { authKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { useManualImportStore } from "../../store";
import { ManualImportReview } from "../manual-import-review";

const sources = [
	{
		instanceId: "instance",
		instanceName: "Synthetic source",
		service: "sonarr" as const,
		downloadId: "reviewed-download",
	},
];
const candidates = [1, 2, 3].map((id) => ({
	service: "sonarr",
	id,
	path: `/synthetic/file-${id}`,
	downloadId: "reviewed-download",
	series: { id: 12, title: `Synthetic series ${id}` },
	episodes: [
		{ id: id * 10 + 1, title: "First episode", seasonNumber: 1, episodeNumber: 1 },
		{ id: id * 10 + 2, title: "Second episode", seasonNumber: 1, episodeNumber: 2 },
	],
	quality: { quality: { id: 1 } },
	...(id === 3 ? { rejections: [{ reason: "Synthetic provider rejection" }] } : {}),
}));
const pending: ManualImportOperationStatus = {
	operationId: "reviewed-operation",
	state: "pending",
	reason: null,
	selectedFileCount: 1,
	verifiedFileCount: 0,
	canConsiderNewAttempt: false,
};
let progress: ManualImportOperationStatus;
let progressStatus: number;
let postMode: "normal" | "lost" | "contradictory";
let postGate: ReturnType<typeof deferred> | null;
let posts: Array<Record<string, unknown>>;
let reads: string[];
let clients: QueryClient[];
let settledPosts: Promise<void>[];
const receipts: unknown[] = [];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const response = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
	sessionStorage.clear();
	localStorage.clear();
	useManualImportStore.getState().clear();
	vi.stubGlobal("crypto", webcrypto);
	posts = [];
	reads = [];
	clients = [];
	settledPosts = [];
	postGate = null;
	postMode = "normal";
	progressStatus = 200;
	progress = { ...pending };
	// Only the HTTP transport is synthetic. Review, modal, selection store, hooks,
	// persistence, query cache, response parser, and rendered progress are maintained code.
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, options?: RequestInit) => {
			if (options?.method === "POST") {
				let settle!: () => void;
				settledPosts.push(
					new Promise<void>((resolve) => {
						settle = resolve;
					}),
				);
				try {
					posts.push(JSON.parse(String(options.body)));
					if (postGate) await postGate.promise;
					if (postMode === "lost") throw new TypeError("Synthetic lost acknowledgement");
					return response(
						postMode === "contradictory"
							? { ...pending, state: "completed", verifiedFileCount: 0 }
							: progress,
						202,
					);
				} finally {
					settle();
				}
			}
			reads.push(url);
			if (url.includes("/source")) return response({ kind: "none" });
			if (url.includes("/operations"))
				return response(
					progressStatus === 200 ? progress : { error: "Synthetic evidence unavailable" },
					progressStatus,
				);
			return response({ candidates, total: candidates.length });
		}),
	);
});
afterEach(async () => {
	postGate?.resolve();
	await act(async () => {
		await Promise.all(settledPosts);
	});
	receipts.push({
		test: expect.getState().currentTestName,
		posts,
		reads,
		postMode,
		allHeldPostsJoined: true,
	});
	cleanup();
	clients.forEach((client) => {
		client.clear();
	});
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
afterAll(() => {
	if (process.env.V4_EVIDENCE_ROOT)
		writeFileSync(
			join(process.env.V4_EVIDENCE_ROOT, "reviewed-ui-requests.json"),
			JSON.stringify(receipts, null, 2),
		);
});
function show() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	clients.push(client);
	client.setQueryData(authKeys.currentUser, { id: "owner", username: "Synthetic owner" });
	const completed = vi.fn();
	const changed = vi.fn();
	return {
		client,
		completed,
		changed,
		...render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<ManualImportReview
							sources={sources}
							open
							onOpenChange={changed}
							onCompleted={completed}
						/>
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		),
	};
}
async function selectReviewedFile() {
	const boxes = await screen.findAllByRole("checkbox", { name: "Select file" });
	expect(boxes).toHaveLength(3);
	expect(boxes.every((box) => !(box as HTMLInputElement).checked)).toBe(true);
	fireEvent.click(boxes[1]!);
	// Uncheck the second episode of only the reviewed second file.
	const episode = screen
		.getAllByRole("checkbox")
		.find(
			(input) =>
				(input as HTMLInputElement).checked &&
				input.getAttribute("aria-label") !== "Select file" &&
				input.parentElement?.textContent?.includes("Second episode"),
		);
	expect(episode).toBeDefined();
	fireEvent.click(episode!);
	const submit = screen.getByRole("button", { name: "Import 1 selected" });
	await waitFor(() => expect(submit).toBeEnabled());
	return submit;
}

describe("Manual Import maintained reviewed selection and recovery actions", () => {
	// Catches accidental submission of unreviewed files/episodes or a missing in-flight fence.
	it("submits only the reviewed file and episode once while pending, then renders current verified completion", async () => {
		const view = show();
		postGate = deferred();
		const submit = await selectReviewedFile();
		fireEvent.click(submit);
		fireEvent.click(submit);
		await waitFor(() => expect(posts).toHaveLength(1));
		expect(posts[0]).toEqual({
			instanceId: "instance",
			service: "sonarr",
			importMode: "auto",
			idempotencyKey: expect.any(String),
			files: [
				{
					path: "/synthetic/file-2",
					folderName: "",
					downloadId: "reviewed-download",
					quality: { quality: { id: 1 } },
					indexerFlags: 0,
					seriesId: 12,
					episodeIds: [21],
				},
			],
		});
		expect(screen.getByRole("button", { name: /Requesting import/ })).toBeDisabled();
		expect(view.completed).not.toHaveBeenCalled();
		await act(async () => postGate!.resolve());
		await screen.findByText(/0 of 1 files verified/);
		expect(view.completed).not.toHaveBeenCalled();
		expect(view.changed).not.toHaveBeenCalled();
		progress = { ...pending, state: "completed", verifiedFileCount: 1 };
		fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
		await screen.findByText(/1 of 1 files verified/);
		await waitFor(() =>
			expect(view.completed).toHaveBeenCalledExactlyOnceWith({ status: "success", imported: 1 }),
		);
		expect(posts).toHaveLength(1);
		expect(
			reads.some((url) => url.startsWith("/api/manual-import/operations?idempotencyKey=")),
		).toBe(true);
	});

	// Catches persistence or submission from a review which the user cancels.
	it("cancels an initial explicit selection without persisting an attempt or requesting import", async () => {
		const view = show();
		await selectReviewedFile();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(view.changed).toHaveBeenCalledExactlyOnceWith(false);
		expect(posts).toEqual([]);
		expect(sessionStorage.length).toBe(0);
		expect(view.completed).not.toHaveBeenCalled();
	});

	// The real UI click must contain a rejected action; do not replace this with a hook call.
	it.each(["lost", "contradictory"] as const)(
		"keeps a %s acknowledgement actionable and recovers using GET without replay",
		async (mode) => {
			const view = show();
			postMode = mode;
			progressStatus = 503;
			fireEvent.click(await selectReviewedFile());
			await screen.findByText(/Import response is unavailable/);
			await screen.findByText(/Current evidence is unavailable/);
			expect(posts).toHaveLength(1);
			expect(view.completed).not.toHaveBeenCalled();
			expect(
				screen.queryByRole("button", { name: /Retry original request/ }),
			).not.toBeInTheDocument();
			progressStatus = 200;
			progress = { ...pending, state: "unknown", reason: "evidence-unavailable" };
			fireEvent.click(screen.getByRole("button", { name: "Check progress" }));
			await screen.findByText(/0 of 1 files verified/);
			expect(posts).toHaveLength(1);
			expect(view.completed).not.toHaveBeenCalled();
			expect(reads.filter((url) => url.includes("/operations")).length).toBeGreaterThanOrEqual(2);
		},
	);
});
