import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Toaster, toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

type Event = { url: string; method: string; body: Record<string, unknown> | null };
let client: QueryClient;
const events: Event[] = [],
	unexpected: string[] = [],
	pending = new Set<Promise<Response>>();
const gates: Array<{
	promise: Promise<Response>;
	release: (response: Response) => void;
	closed: boolean;
}> = [];
function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function gate() {
	let resolve!: (response: Response) => void;
	const value = {
		promise: new Promise<Response>((done) => {
			resolve = done;
		}),
		release: (result: Response) => {
			value.closed = true;
			resolve(result);
		},
		closed: false,
	};
	gates.push(value);
	return value;
}
function transport(handler: (event: Event) => Response | Promise<Response> | undefined) {
	vi.stubGlobal(
		"fetch",
		vi.fn((input: string | URL | Request, init?: RequestInit) => {
			const event = {
				url: String(input),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : null,
			};
			events.push(event);
			const task = Promise.resolve().then(() => {
				const result = handler(event);
				if (!result) {
					unexpected.push(JSON.stringify(event));
					throw Error("Unexpected synthetic fetch " + event.url);
				}
				return result;
			});
			pending.add(task);
			void task.then(
				() => pending.delete(task),
				() => pending.delete(task),
			);
			return task;
		}),
	);
}
function mount(children: ReactNode) {
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					{children}
					<Toaster />
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}
const service = {
	id: "radarr-a",
	service: "radarr",
	label: "Synthetic Radarr",
	baseUrl: "http://synthetic.invalid",
	externalUrl: null,
	enabled: true,
	isDefault: true,
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
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	tags: [],
};
beforeEach(() => {
	events.length = 0;
	unexpected.length = 0;
	gates.length = 0;
	localStorage.clear();
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			media: "",
			onchange: null,
			addListener() {},
			removeListener() {},
			addEventListener() {},
			removeEventListener() {},
			dispatchEvent() {
				return false;
			},
		})),
	);
});
afterEach(async () => {
	await act(async () => {
		for (const held of gates)
			if (!held.closed) held.release(response({ message: "Synthetic teardown refusal" }, 503));
		await Promise.allSettled([...pending]);
	});
	cleanup();
	await client?.cancelQueries();
	client?.clear();
	toast.dismiss();
	expect(pending.size).toBe(0);
	expect(gates.every((value) => value.closed)).toBe(true);
	expect(unexpected).toEqual([]);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

import { useApplyQualitySize } from "../../../../hooks/api/useQualitySize";
import { QualitySizeManager } from "../quality-size-manager";

describe("Quality size maintained transport/recovery", () => {
	function fixture(apply: (event: Event) => Response | Promise<Response>) {
		transport((event) => {
			if (event.url === "/api/services") return response({ services: [service] });
			if (event.url.includes("/quality-size/presets?"))
				return response({
					success: true,
					presets: [
						{
							trash_id: "size-a",
							type: "movie",
							qualities: [{ quality: "WEBDL-1080p", min: 1, preferred: 2, max: 3 }],
						},
					],
				});
			if (event.url.includes("/quality-size/mapping?"))
				return response({
					success: true,
					mapping: {
						presetTrashId: "size-a",
						presetType: "movie",
						syncStrategy: "manual",
						lastAppliedAt: "2026-01-01T00:00:00Z",
					},
				});
			if (event.url.endsWith("/quality-size/preview"))
				return response({
					success: true,
					preset: { trashId: "size-a", type: "movie" },
					comparisons: [
						{
							qualityName: "WEBDL-1080p",
							instanceDefinitionId: 7,
							instanceTitle: "Selected quality",
							current: { min: 0, preferred: 0, max: 0 },
							trash: { min: 1, preferred: 2, max: 3 },
							matched: true,
							changed: true,
						},
					],
					summary: { matched: 1, changed: 1, unmatched: 0, total: 1 },
					currentPresetHash: "synthetic",
					existingMapping: null,
				});
			if (event.url.endsWith("/quality-size/apply")) return apply(event);
			if (event.url.endsWith("/quality-size/sync-strategy"))
				return response({ success: true, syncStrategy: event.body!.syncStrategy });
		});
	}
	it("W3 preset preview/apply refusal retains selection and strategy, deliberate retry and strategy save", async () => {
		const held = gate();
		let attempts = 0;
		fixture(() =>
			++attempts === 1
				? held.promise
				: response({
						success: true,
						appliedCount: 1,
						totalQualities: 1,
						message: "Selected size applied",
					}),
		);
		mount(<QualitySizeManager />);
		fireEvent.click(await screen.findByRole("button", { name: /Synthetic Radarr/ }));
		fireEvent.click(await screen.findByRole("button", { name: /Movie/ }));
		await screen.findByText("Selected quality");
		fireEvent.click(screen.getByRole("radio", { name: /Notify only/ }));
		await waitFor(() => expect(events.some((event) => event.method === "PATCH")).toBe(true));
		fireEvent.click(screen.getByRole("button", { name: "Apply to Synthetic Radarr" }));
		await screen.findByRole("button", { name: "Applying..." });
		await act(async () => held.release(response({ message: "Size refused" }, 502)));
		await screen.findByText("Apply failed: Size refused");
		fireEvent.click(screen.getByRole("button", { name: "Apply to Synthetic Radarr" }));
		await screen.findByText("Selected size applied");
		await waitFor(() =>
			expect(
				screen
					.getAllByText("Selected size applied")
					.some((node) => node.closest('[data-sonner-toast][data-type="success"]')),
			).toBe(true),
		);
		expect(
			events
				.filter((event) => event.url.endsWith("/quality-size/apply"))
				.map((event) => event.body),
		).toEqual([
			{ instanceId: "radarr-a", presetTrashId: "size-a", syncStrategy: "notify" },
			{ instanceId: "radarr-a", presetTrashId: "size-a", syncStrategy: "notify" },
		]);
		expect(events.filter((event) => event.method === "PATCH").map((event) => event.body)).toEqual([
			{ instanceId: "radarr-a", syncStrategy: "notify" },
		]);
	});
	it("W4 queued default reset ACK must not be rendered as completed provider reset", async () => {
		const held = gate();
		fixture(() => held.promise);
		mount(<QualitySizeManager />);
		fireEvent.click(await screen.findByRole("button", { name: /Synthetic Radarr/ }));
		fireEvent.click(await screen.findByRole("button", { name: /^Default/ }));
		fireEvent.click(screen.getByRole("button", { name: "Reset Synthetic Radarr to Defaults" }));
		await screen.findByRole("button", { name: "Resetting..." });
		// Exact current native route-shaped response. Native V1055 proves command
		// still queued and live definitions unchanged when this ACK is returned.
		await act(async () =>
			held.release(
				response({
					success: true,
					appliedCount: 0,
					totalQualities: 0,
					message: "Reset quality sizes to factory defaults on Synthetic Radarr",
				}),
			),
		);
		await waitFor(() =>
			expect(screen.queryByRole("button", { name: "Resetting..." })).not.toBeInTheDocument(),
		);
		expect(
			events
				.filter((event) => event.url.endsWith("/quality-size/apply"))
				.map((event) => event.body),
		).toEqual([{ instanceId: "radarr-a", presetTrashId: "default", syncStrategy: "manual" }]);
		expect
			.soft(
				screen.queryByText("Reset quality sizes to factory defaults on Synthetic Radarr", {
					selector: "p.text-green-400",
				}),
			)
			.not.toBeInTheDocument();
		expect(
			screen.queryAllByText(/queued|requested|pending.*reset|reset.*pending/i).length,
		).toBeGreaterThan(0);
		expect(
			screen.queryByText("Reset quality sizes to factory defaults on Synthetic Radarr", {
				selector: "p.text-green-400",
			}),
		).not.toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(
			/requested.*not confirmed.*task status.*Quality settings/i,
		);
		await waitFor(() =>
			expect(document.querySelector('[data-sonner-toast][data-type="info"]')).toHaveTextContent(
				/requested.*not confirmed/i,
			),
		);
		expect(document.querySelector('[data-sonner-toast][data-type="success"]')).toBeNull();
	});
	it("W4 structured requested ACK renders neutral guidance even with misleading legacy response wording", async () => {
		fixture(() =>
			response({
				success: true,
				resetStatus: "requested",
				appliedCount: 0,
				totalQualities: 0,
				message: "Reset completed",
			}),
		);
		mount(<QualitySizeManager />);
		fireEvent.click(await screen.findByRole("button", { name: /Synthetic Radarr/ }));
		fireEvent.click(await screen.findByRole("button", { name: /^Default/ }));
		fireEvent.click(screen.getByRole("button", { name: "Reset Synthetic Radarr to Defaults" }));
		expect(await screen.findByRole("status")).toHaveTextContent(/requested.*not confirmed/i);
		expect(screen.queryByText("Reset completed")).not.toBeInTheDocument();
		await waitFor(() =>
			expect(document.querySelector('[data-sonner-toast][data-type="info"]')).toHaveTextContent(
				/requested.*not confirmed/i,
			),
		);
		expect(document.querySelector('[data-sonner-toast][data-type="success"]')).toBeNull();
	});
	it("W4 hook honors structured requested state independently of English wording or preset variables", async () => {
		function RequestedAction() {
			const mutation = useApplyQualitySize();
			return (
				<button
					type="button"
					onClick={() => mutation.mutate({ instanceId: "radarr-a", presetTrashId: "size-a" })}
				>
					Apply structured ACK
				</button>
			);
		}
		fixture(() =>
			response({
				success: true,
				resetStatus: "requested",
				appliedCount: 0,
				totalQualities: 0,
				message: "Operation completed",
			}),
		);
		mount(<RequestedAction />);
		fireEvent.click(screen.getByRole("button", { name: "Apply structured ACK" }));
		await waitFor(() =>
			expect(document.querySelector('[data-sonner-toast][data-type="info"]')).toHaveTextContent(
				/requested.*not confirmed/i,
			),
		);
		expect(screen.queryByText("Operation completed")).not.toBeInTheDocument();
		expect(document.querySelector('[data-sonner-toast][data-type="success"]')).toBeNull();
	});
});
