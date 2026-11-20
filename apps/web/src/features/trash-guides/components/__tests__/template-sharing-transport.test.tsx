import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
const gates: Array<{ close: () => void; closed: boolean }> = [];
function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}
function deferred<T>() {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const value = {
		promise,
		release: (result: T) => {
			value.closed = true;
			resolve(result);
		},
		reject: () => {
			value.closed = true;
			reject(new Error("Synthetic failure"));
		},
		close: () => value.reject(),
		closed: false,
	};
	gates.push(value);
	return value;
}
function gate() {
	const held = deferred<Response>();
	held.close = () => held.release(response({ message: "Synthetic teardown refusal" }, 503));
	return held;
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
function mount(children: ReactNode, mutationRetries = 0) {
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: Infinity },
			mutations: { retry: mutationRetries, retryDelay: 0 },
		},
	});
	return render(children, {
		wrapper: ({ children }) => (
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>
						{children}
						<Toaster />
					</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>
		),
	});
}
const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]')!;
const importButton = () => screen.getByRole("button", { name: "Import Template" });
const importEvents = () => events.filter((event) => event.url.endsWith("/sharing/import"));
const validationBytes = () =>
	events
		.filter((event) => event.url.endsWith("/sharing/validate"))
		.map((event) => event.body?.jsonData);
const readyMessage = "Template is valid and ready to import";
const pendingMessage = "Validating template...";
const firstFile = '{"template":{"name":"First synthetic template"}}';
const secondFile = '{"template":{"name":"Second synthetic template"}}';

async function selectFile(text: string, read = async () => text) {
	// jsdom File.text is the disclosed file-reading platform seam.
	const file = new File([text], "synthetic.json", { type: "application/json" });
	Object.defineProperty(file, "text", { value: read });
	await act(async () => fireEvent.change(fileInput(), { target: { files: [file] } }));
}

function validationResponse({ compatible = true, conflict = "", valid = true } = {}) {
	return response({
		success: true,
		data: {
			valid: valid && compatible,
			validation: {
				valid,
				errors: valid
					? []
					: [{ field: "template", message: "Invalid synthetic template", severity: "error" }],
				warnings: [],
				conflicts: conflict ? [{ type: "name", message: conflict }] : [],
			},
			compatibility: {
				compatible,
				issues: compatible
					? []
					: [{ type: "version", severity: "error", message: "Unsupported version" }],
			},
		},
	});
}

function importResponse() {
	return response(
		{
			success: true,
			data: { template: { id: "imported-template" }, validation: { valid: true } },
		},
		201,
	);
}

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
		for (const held of gates) if (!held.closed) held.close();
		onlineManager.setOnline(true);
		await client?.resumePausedMutations();
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
							errors:
								validations === 1
									? [
											{
												field: "template",
												message: "Invalid synthetic template",
												severity: "error",
											},
										]
									: [],
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
	it("blocks import through reselection and validation, and resets Replace", async () => {
		const reading = deferred<string>();
		const validating = gate();
		transport((event) => {
			if (event.url.endsWith("/sharing/validate")) {
				return event.body?.jsonData === firstFile
					? validationResponse({ conflict: "First name conflict" })
					: validating.promise;
			}
			if (event.url.endsWith("/sharing/import")) return importResponse();
		});
		mount(<EnhancedTemplateImportModal />);
		await selectFile(firstFile);
		await screen.findByText("First name conflict");
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "replace" } });

		await selectFile(secondFile, () => reading.promise);
		fireEvent.click(importButton());
		expect.soft(importEvents().map((event) => event.body?.jsonData)).toEqual([]);
		expect.soft(importButton()).toBeDisabled();
		expect.soft(screen.queryByText("First name conflict")).not.toBeInTheDocument();
		expect.soft(screen.queryByText(pendingMessage)).toBeInTheDocument();

		await act(async () => reading.release(secondFile));
		expect(validationBytes()).toEqual([firstFile, secondFile]);
		fireEvent.click(importButton());
		expect.soft(importEvents().map((event) => event.body?.jsonData)).toEqual([]);
		expect.soft(importButton()).toBeDisabled();

		await act(async () =>
			validating.release(validationResponse({ conflict: "Second name conflict" })),
		);
		expect(screen.getByText("Second name conflict")).toBeInTheDocument();
		expect.soft(screen.getByRole("combobox")).toHaveValue("rename");
		fireEvent.click(importButton());
		await waitFor(() =>
			expect(importEvents().at(-1)?.body).toMatchObject({
				jsonData: secondFile,
				options: { onNameConflict: "rename" },
			}),
		);
		expect(importEvents()).toHaveLength(1);
	});

	it("keeps current progress and blocks import after a stale success and current incompatibility", async () => {
		const older = gate();
		const current = gate();
		transport((event) => {
			if (event.url.endsWith("/sharing/validate")) {
				return event.body?.jsonData === firstFile ? older.promise : current.promise;
			}
			if (event.url.endsWith("/sharing/import")) return importResponse();
		});
		mount(<EnhancedTemplateImportModal />);
		await selectFile(firstFile);
		await selectFile(secondFile);
		expect(screen.getByText(pendingMessage)).toBeInTheDocument();

		await act(async () => older.release(validationResponse()));
		expect.soft(screen.queryByText(pendingMessage)).toBeInTheDocument();
		expect.soft(screen.queryByText(readyMessage)).not.toBeInTheDocument();
		expect.soft(importButton()).toBeDisabled();

		await act(async () => current.release(validationResponse({ compatible: false })));
		expect(screen.getByText("Unsupported version")).toBeInTheDocument();
		fireEvent.click(importButton());
		expect.soft(screen.queryByText(readyMessage)).not.toBeInTheDocument();
		expect.soft(importButton()).toBeDisabled();
		expect(importEvents()).toEqual([]);
	});

	it.each(["read success", "read rejection", "validation success", "validation rejection"])(
		"ignores a superseded %s after the new result",
		async (outcome) => {
			const olderRead = deferred<string>();
			void olderRead.promise.catch(() => {});
			const olderValidation = gate();
			const alert = vi.fn();
			vi.stubGlobal("alert", alert);
			transport((event) => {
				if (event.url.endsWith("/sharing/validate")) {
					return event.body?.jsonData === firstFile
						? olderValidation.promise
						: validationResponse();
				}
				if (event.url.endsWith("/sharing/import")) return importResponse();
			});
			const holdRead = outcome.startsWith("read");
			mount(<EnhancedTemplateImportModal />);
			await selectFile(firstFile, holdRead ? () => olderRead.promise : undefined);
			await selectFile(secondFile);
			await screen.findByText(readyMessage);

			await act(async () => {
				switch (outcome) {
					case "read success":
						olderRead.release(firstFile);
						break;
					case "read rejection":
						olderRead.reject();
						break;
					case "validation success":
						olderValidation.release(validationResponse({ compatible: false }));
						break;
					case "validation rejection":
						olderValidation.reject();
						break;
				}
			});
			expect.soft(validationBytes()).toEqual(holdRead ? [secondFile] : [firstFile, secondFile]);
			expect.soft(screen.queryByText("Unsupported version")).not.toBeInTheDocument();
			expect.soft(alert).not.toHaveBeenCalled();
			fireEvent.click(importButton());
			await waitFor(() => expect(importEvents()[0]?.body?.jsonData).toBe(secondFile));
		},
	);

	it.each(["read", "validation"])(
		"requires successful reselection after current %s fails",
		async (stage) => {
			const reading = deferred<string>();
			void reading.promise.catch(() => {});
			const validating = gate();
			const alert = vi.fn();
			let attempts = 0;
			vi.stubGlobal("alert", alert);
			transport((event) => {
				if (event.url.endsWith("/sharing/validate")) {
					if (event.body?.jsonData === secondFile && stage === "validation" && attempts++ === 0) {
						return validating.promise;
					}
					return validationResponse();
				}
				if (event.url.endsWith("/sharing/import")) return importResponse();
			});
			mount(<EnhancedTemplateImportModal />);
			await selectFile(firstFile);
			await screen.findByText(readyMessage);

			await selectFile(secondFile, stage === "read" ? () => reading.promise : undefined);
			await act(async () => {
				if (stage === "read") reading.reject();
				else validating.release(response({ message: "Validation refused" }, 503));
			});
			expect(alert).toHaveBeenCalledWith(
				stage === "read" ? "Failed to read template file" : "Failed to validate template",
			);
			fireEvent.click(importButton());
			expect.soft(importEvents().map((event) => event.body?.jsonData)).toEqual([]);
			expect.soft(importButton()).toBeDisabled();
			expect.soft(screen.queryByText(readyMessage)).not.toBeInTheDocument();

			await selectFile(secondFile);
			await screen.findByText(readyMessage);
			fireEvent.click(importButton());
			await waitFor(() => expect(importEvents().at(-1)?.body?.jsonData).toBe(secondFile));
			expect(importEvents()).toHaveLength(1);
		},
	);

	it("requires validation of the exact pasted draft after edits", async () => {
		const stale = gate();
		const originalDraft = `  ${firstFile}\n`;
		const finalDraft = `\n  ${secondFile}  \n`;
		transport((event) => {
			if (event.url.endsWith("/sharing/validate")) {
				if (event.body?.jsonData === secondFile) return stale.promise;
				return validationResponse({ conflict: "Paste name conflict" });
			}
			if (event.url.endsWith("/sharing/import")) return importResponse();
		});
		mount(<EnhancedTemplateImportModal />);
		expect(fileInput()).toBeVisible();
		fireEvent.click(screen.getByRole("radio", { name: "Paste JSON" }));
		const draft = screen.getByRole("textbox", { name: "Template JSON" });
		const validate = screen.getByRole("button", { name: "Validate JSON" });
		expect(validate).toBeDisabled();
		fireEvent.change(draft, { target: { value: originalDraft } });
		expect(validationBytes()).toEqual([]);
		expect(importButton()).toBeDisabled();

		fireEvent.click(validate);
		await screen.findByText("Paste name conflict");
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "replace" } });
		fireEvent.change(draft, { target: { value: secondFile } });
		expect(screen.queryByText("Paste name conflict")).not.toBeInTheDocument();
		expect(importButton()).toBeDisabled();

		fireEvent.click(validate);
		await screen.findByText(pendingMessage);
		fireEvent.change(draft, { target: { value: finalDraft } });
		await act(async () => stale.release(validationResponse()));
		expect(screen.queryByText(readyMessage)).not.toBeInTheDocument();
		expect(importButton()).toBeDisabled();
		await act(async () => fireEvent.click(importButton()));
		expect(importEvents()).toEqual([]);

		fireEvent.click(validate);
		await screen.findByText(readyMessage);
		expect(screen.getByRole("combobox")).toHaveValue("rename");
		fireEvent.click(importButton());
		await waitFor(() =>
			expect(importEvents()[0]?.body).toMatchObject({
				jsonData: finalDraft,
				options: { onNameConflict: "rename" },
			}),
		);
		expect(validationBytes()).toEqual([originalDraft, secondFile, finalDraft]);
	});

	it("discards pending proof when switching from file to paste and back", async () => {
		const fileValidation = gate();
		const pasteValidation = gate();
		const close = vi.fn();
		transport((event) => {
			if (event.url.endsWith("/sharing/validate")) {
				return event.body?.jsonData === firstFile
					? fileValidation.promise
					: pasteValidation.promise;
			}
		});
		mount(<EnhancedTemplateImportModal onClose={close} />);
		await selectFile(firstFile);
		await screen.findByText(pendingMessage);

		fireEvent.click(screen.getByRole("radio", { name: "Paste JSON" }));
		expect(screen.queryByText(pendingMessage)).not.toBeInTheDocument();
		fireEvent.change(screen.getByRole("textbox", { name: "Template JSON" }), {
			target: { value: secondFile },
		});
		fireEvent.click(screen.getByRole("button", { name: "Validate JSON" }));
		await screen.findByText(pendingMessage);
		await act(async () => fileValidation.release(validationResponse()));
		expect(screen.getByText(pendingMessage)).toBeInTheDocument();
		expect(importButton()).toBeDisabled();

		fireEvent.click(screen.getByRole("radio", { name: "Upload JSON file" }));
		expect(fileInput()).toBeVisible();
		await act(async () => pasteValidation.release(validationResponse()));
		expect(screen.queryByText(readyMessage)).not.toBeInTheDocument();
		expect(importButton()).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(close).toHaveBeenCalledTimes(1);
		expect(validationBytes()).toEqual([firstFile, secondFile]);
		expect(importEvents()).toEqual([]);
	});

	it("locks selection and dismissal during import and retries the original bytes after refusal", async () => {
		const importing = gate();
		const complete = vi.fn();
		const close = vi.fn();
		transport((event) => {
			if (event.url.endsWith("/sharing/validate")) return validationResponse();
			if (event.url.endsWith("/sharing/import")) {
				return importEvents().length === 1 ? importing.promise : importResponse();
			}
		});
		mount(<EnhancedTemplateImportModal onImportComplete={complete} onClose={close} />);
		await selectFile(firstFile);
		await screen.findByText(readyMessage);
		fireEvent.click(importButton());
		const importingButton = await screen.findByRole("button", { name: "Importing..." });
		expect(importingButton).toBeDisabled();
		fireEvent.click(importingButton);
		expect.soft(fileInput()).toBeDisabled();
		const paste = screen.queryByRole("radio", { name: "Paste JSON" });
		expect.soft(paste).toBeDisabled();
		if (paste) fireEvent.click(paste);
		const dismiss = screen.getByRole("button", { name: "Close import modal" });
		const cancel = screen.getByRole("button", { name: "Cancel" });
		expect.soft(dismiss).toBeDisabled();
		expect.soft(cancel).toBeDisabled();
		fireEvent.click(dismiss);
		fireEvent.click(cancel);
		expect.soft(close).not.toHaveBeenCalled();
		// A change event already queued when Import was clicked must also be ignored.
		const read = vi.fn(async () => secondFile);
		await selectFile(secondFile, read);
		expect.soft(read).not.toHaveBeenCalled();
		expect.soft(validationBytes()).toEqual([firstFile]);

		await act(async () =>
			importing.release(response({ message: "Import refused while pending" }, 409)),
		);
		await screen.findByText("Import refused while pending");
		expect(complete).not.toHaveBeenCalled();
		expect(close).not.toHaveBeenCalled();
		expect(fileInput()).toBeEnabled();
		expect(dismiss).toBeEnabled();
		expect(cancel).toBeEnabled();
		expect(importEvents()).toHaveLength(1);
		fireEvent.click(importButton());
		await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
		expect(close).toHaveBeenCalledTimes(1);
		expect(importEvents().map((event) => event.body?.jsonData)).toEqual([firstFile, firstFile]);
	});

	it("refuses offline import and sends validated bytes only after an explicit retry", async () => {
		const complete = vi.fn();
		transport((event) => {
			if (event.url.endsWith("/sharing/validate")) return validationResponse();
			if (event.url.endsWith("/sharing/import")) return importResponse();
		});
		mount(<EnhancedTemplateImportModal onImportComplete={complete} />);
		await selectFile(firstFile);
		await screen.findByText(readyMessage);

		await act(async () => onlineManager.setOnline(false));
		await act(async () => fireEvent.click(importButton()));
		expect.soft(client.isMutating()).toBe(0);
		expect.soft(importEvents()).toEqual([]);
		await screen.findByText("Reconnect to import the template");

		await act(async () => {
			onlineManager.setOnline(true);
			await client.resumePausedMutations();
		});
		expect.soft(importEvents()).toEqual([]);
		expect.soft(complete).not.toHaveBeenCalled();
		expect(importButton()).toBeEnabled();
		fireEvent.click(importButton());
		await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
		expect(importEvents().map((event) => event.body?.jsonData)).toEqual([firstFile]);
	});

	it("starts an authorized import once if connectivity drops before transport and never replays it", async () => {
		const importing = gate();
		transport((event) => {
			if (event.url.endsWith("/sharing/validate")) return validationResponse();
			if (event.url.endsWith("/sharing/import")) return importing.promise;
		});
		mount(<EnhancedTemplateImportModal />, 2);
		await selectFile(firstFile);
		await screen.findByText(readyMessage);

		await act(async () => {
			fireEvent.click(importButton());
			onlineManager.setOnline(false);
		});
		expect.soft(importEvents()).toHaveLength(1);
		await act(async () =>
			importing.release(response({ message: "Import refused after connectivity changed" }, 409)),
		);
		await act(async () => {
			onlineManager.setOnline(true);
			await client.resumePausedMutations();
		});
		await waitFor(() => expect(client.isMutating()).toBe(0));
		expect(importEvents().map((event) => event.body?.jsonData)).toEqual([firstFile]);
	});

	it.each([
		{ outcome: "success", message: "Template imported successfully", settle: importResponse },
		{
			outcome: "refusal",
			message: "Original import refused",
			settle: () => response({ message: "Original import refused" }, 409),
		},
		{
			outcome: "unconfirmed acknowledgment",
			message: "Request acknowledgment could not be verified.",
			settle: () => response({ success: false }),
		},
	])(
		"blocks a remounted modal during import and reports the original $outcome",
		async ({ outcome, message, settle }) => {
			const importing = gate();
			const originalComplete = vi.fn();
			const originalClose = vi.fn();
			const replacementComplete = vi.fn();
			const replacementClose = vi.fn();
			const templateQuery = ["trash-guides", "templates", { serviceType: "RADARR" }] as const;
			transport((event) => {
				if (event.url.endsWith("/sharing/validate")) return validationResponse();
				if (event.url.endsWith("/sharing/import")) {
					return importEvents().length === 1 ? importing.promise : importResponse();
				}
			});
			const view = mount(
				<EnhancedTemplateImportModal onImportComplete={originalComplete} onClose={originalClose} />,
			);
			client.setQueryData(templateQuery, { templates: [] });
			await selectFile(firstFile);
			await screen.findByText(readyMessage);
			fireEvent.click(importButton());
			await waitFor(() => expect(importEvents()).toHaveLength(1));
			view.rerender(null);
			view.rerender(
				<EnhancedTemplateImportModal
					onImportComplete={replacementComplete}
					onClose={replacementClose}
				/>,
			);

			expect.soft(screen.queryByRole("button", { name: "Importing..." })).toBeDisabled();
			expect.soft(fileInput()).toBeDisabled();
			const read = vi.fn(async () => secondFile);
			await selectFile(secondFile, read);
			expect.soft(read).not.toHaveBeenCalled();
			const replacementImport = screen.queryByRole("button", { name: "Import Template" });
			if (replacementImport) await act(async () => fireEvent.click(replacementImport));
			expect.soft(importEvents().map((event) => event.body?.jsonData)).toEqual([firstFile]);

			await act(async () => importing.release(settle()));
			await screen.findByText(message);
			await waitFor(() => expect(fileInput()).toBeEnabled());
			expect(validationBytes()).toEqual([firstFile]);
			expect(importButton()).toBeDisabled();
			expect(importEvents()).toHaveLength(1);
			expect(originalComplete).not.toHaveBeenCalled();
			expect(originalClose).not.toHaveBeenCalled();
			expect(replacementComplete).not.toHaveBeenCalled();
			expect(replacementClose).not.toHaveBeenCalled();
			expect(client.getQueryState(templateQuery)?.isInvalidated).toBe(outcome === "success");
		},
	);

	it("announces validation progress and outcomes through one persistent status region", async () => {
		const validating = gate();
		transport((event) => {
			if (event.url.endsWith("/sharing/validate")) {
				if (event.body?.jsonData === firstFile) return validating.promise;
				if (event.body?.jsonData === secondFile) return validationResponse({ compatible: false });
				return validationResponse({ valid: false });
			}
		});
		mount(<EnhancedTemplateImportModal />);
		const status = screen.getByRole("status");
		expect(status).toBeEmptyDOMElement();
		await selectFile(firstFile);
		expect(status).toHaveTextContent(pendingMessage);
		await act(async () => validating.release(validationResponse()));
		expect(status).toHaveTextContent(readyMessage);

		await selectFile(secondFile);
		expect(status).toHaveTextContent("Template is incompatible and cannot be imported");
		expect(screen.getByText("Unsupported version")).toBeVisible();
		await selectFile("{invalid");
		expect(status).toHaveTextContent("Template has validation errors that must be fixed");
		expect(screen.getByText(/Invalid synthetic template/)).toBeVisible();
		expect(screen.getByRole("status")).toBe(status);
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
