import type { SeerrRequest, ServiceInstanceSummary } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { RequestsClient } from "../requests-client";

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));

const stamp = "2026-10-01T12:00:00Z";
const connection = (id: "north" | "south"): ServiceInstanceSummary => ({
	id,
	service: "seerr",
	label: `Synthetic ${id}`,
	baseUrl: "https://seerr.invalid",
	externalUrl: null,
	enabled: true,
	isDefault: id === "north",
	hasApiKey: true,
	hasHttpAuth: false,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "unverified",
		kind: null,
		fingerprint: null,
		verifiedAt: null,
		lastCheckedAt: null,
	},
	createdAt: stamp,
	updatedAt: stamp,
	tags: [],
});
const viewer = {
	id: 5,
	displayName: "Synthetic viewer",
	createdAt: stamp,
	updatedAt: stamp,
	permissions: 1,
	requestCount: 0,
	userType: 1,
};
const quotaUser = (id: string) => ({
	...viewer,
	id: 41,
	displayName: `Quota user ${id}`,
	movieQuotaLimit: 4,
	movieQuotaDays: 7,
	tvQuotaLimit: null,
	tvQuotaDays: null,
});
const request = (id: string): SeerrRequest => ({
	id: 41,
	status: 1,
	type: "movie",
	is4k: false,
	createdAt: stamp,
	updatedAt: stamp,
	media: {
		id: 7,
		tmdbId: 7,
		status: 2,
		createdAt: stamp,
		updatedAt: stamp,
		title: `Request on ${id}`,
	},
	requestedBy: viewer,
});
const page = (results: unknown[]) => ({
	pageInfo: { pages: 1, pageSize: 50, results: results.length, page: 1 },
	results,
});
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let client: QueryClient | undefined;
const unexpected: string[] = [];

function mount(reply?: () => Response | Promise<Response>) {
	const posts: Array<{ path: string; message: string }> = [];
	const reads: string[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = new URL(String(input), "https://dashboard.invalid");
		const { pathname } = url;
		const method = init?.method ?? "GET";
		if (method === "GET") reads.push(pathname);
		if (method === "GET" && pathname === "/api/services")
			return json({ services: [connection("north"), connection("south")] });
		if (method === "GET" && /^\/api\/seerr\/status\/(north|south)\/health$/.test(pathname))
			return json({ status: "healthy", lastCheckedAt: stamp, error: null });
		if (method === "GET" && /^\/api\/seerr\/status\/(north|south)$/.test(pathname))
			return json({
				version: "1.0.0",
				commitTag: "synthetic",
				updateAvailable: false,
				commitsBehind: 0,
			});
		if (method === "GET" && /^\/api\/seerr\/requests\/(north|south)\/count$/.test(pathname))
			return json({
				total: 0,
				movie: 0,
				tv: 0,
				pending: 0,
				approved: 0,
				declined: 0,
				processing: 0,
				available: 0,
			});
		const source = pathname.split("/")[4] ?? "";
		if (method === "GET" && /^\/api\/seerr\/requests\/(north|south)$/.test(pathname))
			return json(page([request(source)]));
		if (method === "GET" && /^\/api\/seerr\/users\/(north|south)$/.test(pathname))
			return json(
				page([
					url.searchParams.get("sort") === "created"
						? { ...quotaUser(source), id: 42, displayName: `Replacement quota user ${source}` }
						: quotaUser(source),
				]),
			);
		if (method === "GET" && /^\/api\/seerr\/users\/(north|south)\/\d+\/quota$/.test(pathname))
			return json({
				movie: { limit: 4, used: 1, days: 7, restricted: false },
				tv: { limit: 0, used: 0, days: 7, restricted: false },
			});
		if (method === "GET" && /^\/api\/seerr\/discover\/(north|south)\/movie\/7$/.test(pathname))
			return json({}, 503);
		if (
			method === "GET" &&
			/^\/api\/seerr\/discover\/(north|south)\/request-options$/.test(pathname)
		)
			return json({
				coverage: "complete",
				configuredServerCount: 1,
				unavailableServerCount: 0,
				servers: [
					{
						server: {
							id: 1,
							name: "Synthetic server",
							is4k: false,
							isDefault: true,
							activeProfileId: 11,
							activeDirectory: "/synthetic/1",
							activeTags: [],
						},
						profiles: [{ id: 11, name: "Synthetic profile" }],
						rootFolders: [{ id: 101, path: "/synthetic/1" }],
						tags: [],
						languageProfiles: null,
					},
				],
			});
		if (method !== "GET") {
			posts.push({ path: pathname, message: method });
			if (
				reply &&
				((method === "POST" && pathname === "/api/seerr/requests/north/41/approve") ||
					(method === "PUT" && pathname === "/api/seerr/users/north/41"))
			)
				return reply();
			return json({ error: "Synthetic write blocked" }, 500);
		}
		unexpected.push(`${method} ${pathname}`);
		return json({ error: "Unexpected synthetic request" }, 500);
	});
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<RequestsClient />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return { posts, reads, client };
}
afterEach(() => {
	cleanup();
	client?.clear();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	localStorage.clear();
	expect(unexpected.splice(0)).toEqual([]);
});

async function changeDefault(view: ReturnType<typeof mount>, target = "south") {
	await act(async () => {
		view.client.setQueryData(
			["services"],
			[
				{ ...connection("north"), isDefault: target === "north" },
				{ ...connection("south"), isDefault: target === "south" },
			],
		);
	});
	await waitFor(() =>
		expect(document.querySelector('option[value="south"]')?.closest("select")).toHaveValue(target),
	);
}

it("closes an old quota editor when a services refresh changes the default source", async () => {
	const view = mount();
	fireEvent.click(await screen.findByRole("button", { name: /^Users$/ }));
	await screen.findByText("Quota user north");
	fireEvent.click(screen.getByTitle("Manage user quotas"));
	const dialog = within(await screen.findByRole("dialog"));
	expect(dialog.getByText("Quota user north")).toBeInTheDocument();
	fireEvent.change(dialog.getAllByLabelText("Request limit")[0]!, { target: { value: "9" } });
	expect(dialog.getByRole("button", { name: "Save" })).toBeEnabled();
	await changeDefault(view);
	await screen.findByText("Quota user south");
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	expect(view.posts).toEqual([]);
});

it("closes an old request detail when a services refresh changes the default source", async () => {
	const view = mount();
	fireEvent.click(await screen.findByText("Request on north"));
	expect(await screen.findByRole("dialog")).toBeInTheDocument();
	await changeDefault(view);
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	await waitFor(() =>
		expect(
			screen.getByRole("checkbox", { name: "Select request for Request on south" }),
		).toBeInTheDocument(),
	);
	expect(view.reads).not.toContain("/api/seerr/discover/south/movie/7");
	await changeDefault(view, "north");
	await screen.findByText("Request on north");
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	expect(view.posts).toEqual([]);
});

it("closes stale approval options instead of loading options from another instance", async () => {
	const view = mount();
	await screen.findByText("Request on north");
	fireEvent.click(screen.getByTitle("Approve with quality profile options"));
	expect(await screen.findByRole("dialog")).toBeInTheDocument();
	await changeDefault(view);
	expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	await waitFor(() =>
		expect(
			screen.getByRole("checkbox", { name: "Select request for Request on south" }),
		).toBeInTheDocument(),
	);
	expect(view.reads).not.toContain("/api/seerr/discover/south/request-options");
	expect(view.posts).toEqual([]);
});

function held(response: Response) {
	let release!: () => void;
	const promise = new Promise<Response>((resolve) => {
		release = () => resolve(response);
	});
	return { reply: () => promise, release };
}

it("settles a held detail approval against the reopened same-source request", async () => {
	const call = held(json({ ...request("north"), status: 2 }));
	const view = mount(call.reply);
	fireEvent.click(await screen.findByText("Request on north"));
	const initial = within(await screen.findByRole("dialog"));
	fireEvent.click(initial.getByRole("button", { name: /^Approve$/ }));
	try {
		await waitFor(() => expect(view.posts).toHaveLength(1));
		fireEvent.click(initial.getByRole("button", { name: /^Close$/ }));
		fireEvent.click(screen.getByText("Request on north"));
		expect(await screen.findByRole("dialog")).toBeInTheDocument();
	} finally {
		await act(async () => call.release());
	}
	await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	expect(view.posts).toEqual([{ path: "/api/seerr/requests/north/41/approve", message: "POST" }]);
});

it("settles a held quota save with an unknown warning after the editor closes on source change", async () => {
	const warning = vi.spyOn(toast, "warning");
	const success = vi.spyOn(toast, "success");
	const call = held(json({ error: "SeerrMutationOutcomeUnknownError" }, 502));
	const view = mount(call.reply);
	fireEvent.click(await screen.findByRole("button", { name: /^Users$/ }));
	await screen.findByText("Quota user north");
	fireEvent.click(screen.getByTitle("Manage user quotas"));
	const dialog = within(await screen.findByRole("dialog"));
	fireEvent.change(dialog.getAllByLabelText("Request limit")[0]!, { target: { value: "9" } });
	fireEvent.click(dialog.getByRole("button", { name: "Save" }));
	try {
		await waitFor(() => expect(view.posts).toHaveLength(1));
		await changeDefault(view);
		await screen.findByText("Quota user south");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	} finally {
		await act(async () => call.release());
	}
	await waitFor(() =>
		expect(warning).toHaveBeenCalledWith("Outcome unknown. Check Seerr before retrying."),
	);
	expect(success).not.toHaveBeenCalled();
	expect(view.posts).toEqual([{ path: "/api/seerr/users/north/41", message: "PUT" }]);
});

it("settles a held options approval with success feedback after its source is closed", async () => {
	const success = vi.spyOn(toast, "success");
	const call = held(json({ ...request("north"), status: 2 }));
	const view = mount(call.reply);
	await screen.findByText("Request on north");
	fireEvent.click(screen.getByTitle("Approve with quality profile options"));
	const dialog = within(await screen.findByRole("dialog"));
	const approve = await dialog.findByRole("button", { name: /^Approve$/ });
	await waitFor(() => expect(approve).toBeEnabled());
	fireEvent.click(approve);
	try {
		await waitFor(() => expect(view.posts).toHaveLength(1));
		await changeDefault(view);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	} finally {
		await act(async () => call.release());
	}
	await waitFor(() => expect(success).toHaveBeenCalledWith("Request approved"));
	expect(view.posts).toEqual([{ path: "/api/seerr/requests/north/41/approve", message: "POST" }]);
});

it("keeps a replacement quota editor open when the previous save settles on the same instance", async () => {
	const success = vi.spyOn(toast, "success");
	const call = held(json(quotaUser("north")));
	const view = mount(call.reply);
	fireEvent.click(await screen.findByRole("button", { name: /^Users$/ }));
	await screen.findByText("Quota user north");
	fireEvent.click(screen.getByTitle("Manage user quotas"));
	const oldDialog = within(await screen.findByRole("dialog"));
	fireEvent.change(oldDialog.getAllByLabelText("Request limit")[0]!, { target: { value: "9" } });
	fireEvent.click(oldDialog.getByRole("button", { name: "Save" }));
	try {
		await waitFor(() => expect(view.posts).toHaveLength(1));
		fireEvent.click(oldDialog.getByRole("button", { name: "Close dialog" }));
		const sort = screen.getByRole("option", { name: "Newest" }).closest("select");
		expect(sort).not.toBeNull();
		fireEvent.change(sort!, { target: { value: "created" } });
		await screen.findByText("Replacement quota user north");
		fireEvent.click(screen.getByTitle("Manage user quotas"));
		const nextDialog = within(await screen.findByRole("dialog"));
		fireEvent.change(nextDialog.getAllByLabelText("Request limit")[0]!, {
			target: { value: "12" },
		});
	} finally {
		await act(async () => call.release());
	}
	await waitFor(() =>
		expect(success).toHaveBeenCalledWith("Updated quota settings for Quota user north"),
	);
	const nextDialog = within(await screen.findByRole("dialog"));
	expect(nextDialog.getByText("Replacement quota user north")).toBeInTheDocument();
	expect(nextDialog.getAllByLabelText("Request limit")[0]).toHaveValue(12);
	expect(view.posts).toEqual([{ path: "/api/seerr/users/north/41", message: "PUT" }]);
});
