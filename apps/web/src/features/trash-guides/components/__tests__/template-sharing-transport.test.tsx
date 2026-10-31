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

import { EnhancedTemplateExportModal } from "../enhanced-template-export-modal";
import { EnhancedTemplateImportModal } from "../enhanced-template-import-modal";

describe("Enhanced template sharing maintained transport", () => {
	it("W7 JSON validation/options/commit refusal recovery uses only validated current input", async () => {
		const complete = vi.fn(),
			close = vi.fn();
		let attempts = 0,
			validations = 0;
		transport((event) => {
			if (event.url.endsWith("/sharing/validate")) {
				validations++;
				return response({
					success: true,
					data: {
						valid: validations > 1,
						validation: {
							valid: validations > 1,
							errors: validations === 1 ? ["Invalid synthetic template"] : [],
							warnings: [],
							conflicts: [],
						},
						compatibility: { compatible: true, issues: [] },
					},
				});
			}
			if (event.url.endsWith("/sharing/import"))
				return ++attempts === 1
					? response({ message: "Import commit refused" }, 409)
					: response(
							{
								success: true,
								data: { template: { id: "imported-template" }, validation: { valid: true } },
							},
							201,
						);
		});
		mount(<EnhancedTemplateImportModal onImportComplete={complete} onClose={close} />);
		const input = document.querySelector('input[type="file"]')!;
		const selectFile = async (text: string) => {
			// jsdom File.text is the disclosed file-reading platform seam.
			const file = new File([text], "synthetic.json", { type: "application/json" });
			Object.defineProperty(file, "text", { value: async () => text });
			await act(async () => fireEvent.change(input, { target: { files: [file] } }));
		};
		await selectFile("{invalid");
		await screen.findByText("Template has validation errors that must be fixed");
		expect(screen.getByRole("button", { name: "Import Template" })).toBeDisabled();
		expect(attempts).toBe(0);
		const valid =
			'{"version":"2.0","template":{"name":"Synthetic","serviceType":"RADARR","config":{"customFormats":[]}}}';
		await selectFile(valid);
		await screen.findByText("Template is valid and ready to import");
		fireEvent.click(screen.getByRole("checkbox", { name: /Import Quality Settings/i }));
		fireEvent.click(screen.getByRole("button", { name: "Import Template" }));
		await screen.findByText("Import commit refused");
		expect(complete).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Import Template" }));
		await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
		expect(
			events.filter((event) => event.url.endsWith("/sharing/import")).map((event) => event.body),
		).toEqual([
			{
				jsonData: valid,
				options: {
					onNameConflict: "rename",
					includeQualitySettings: false,
					includeCustomConditions: true,
					includeMetadata: true,
					strictValidation: false,
				},
			},
			{
				jsonData: valid,
				options: {
					onNameConflict: "rename",
					includeQualitySettings: false,
					includeCustomConditions: true,
					includeMetadata: true,
					strictValidation: false,
				},
			},
		]);
		// This maintained modal renders validation feedback, not a /sharing/preview caller.
	});
	it("W8 selected export options held refusal retain draft and explicit retry; download is only a platform stub", async () => {
		const held = gate(),
			close = vi.fn(),
			alert = vi.fn();
		let attempts = 0;
		vi.stubGlobal("alert", alert);
		Object.defineProperty(URL, "createObjectURL", {
			configurable: true,
			value: vi.fn(() => "blob:synthetic"),
		});
		Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		transport((event) =>
			event.url.endsWith("/sharing/export")
				? ++attempts === 1
					? held.promise
					: response({ version: "2.0", template: { name: "Selected template" } })
				: undefined,
		);
		mount(
			<EnhancedTemplateExportModal
				templateId="template-selected"
				templateName="Selected template"
				onClose={close}
			/>,
		);
		fireEvent.change(screen.getByPlaceholderText("Your name or username"), {
			target: { value: "Synthetic author" },
		});
		fireEvent.change(screen.getByPlaceholderText("4K, HDR, remux, anime"), {
			target: { value: "one, two" },
		});
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "movies" } });
		fireEvent.click(screen.getByRole("checkbox", { name: /Include Quality Settings/i }));
		fireEvent.click(screen.getByRole("button", { name: "Export Template" }));
		await screen.findByRole("button", { name: /Exporting/ });
		await act(async () => held.release(response({ message: "Refused" }, 503)));
		await waitFor(() => expect(alert).toHaveBeenCalledWith("Failed to export template"));
		expect(close).not.toHaveBeenCalled();
		expect(screen.getByPlaceholderText("Your name or username")).toHaveValue("Synthetic author");
		fireEvent.click(screen.getByRole("button", { name: "Export Template" }));
		await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
		expect(
			events.filter((event) => event.url.endsWith("/sharing/export")).map((event) => event.body),
		).toEqual([
			{
				templateId: "template-selected",
				options: {
					includeQualitySettings: false,
					includeCustomConditions: true,
					includeMetadata: true,
					author: "Synthetic author",
					category: "movies",
					tags: ["one", "two"],
				},
			},
			{
				templateId: "template-selected",
				options: {
					includeQualitySettings: false,
					includeCustomConditions: true,
					includeMetadata: true,
					author: "Synthetic author",
					category: "movies",
					tags: ["one", "two"],
				},
			},
		]);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
	});
});
