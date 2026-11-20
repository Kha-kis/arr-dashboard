import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider, useIncognitoMode } from "../IncognitoContext";

const key = "arr-dashboard-incognito-mode";
let rendered: boolean[];
function Consumer() {
	const [masked, setMasked] = useIncognitoMode();
	rendered.push(masked);
	return (
		<>
			<output>{masked ? "Masked" : "Visible"}</output>
			<button type="button" onClick={() => setMasked(!masked)}>
				Toggle privacy
			</button>
		</>
	);
}
const view = () => (
	<IncognitoProvider>
		<Consumer />
	</IncognitoProvider>
);
beforeEach(() => {
	localStorage.clear();
	rendered = [];
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	localStorage.clear();
});
describe("real IncognitoProvider storage recovery", () => {
	it("starts masked on the server before a preference can be established", () => {
		expect(renderToString(view())).toContain("Masked");
		expect(rendered).toEqual([true]);
	});
	it.each([
		["true", "Masked"],
		["false", "Visible"],
		[null, "Visible"],
	])("reads working stored preference %s after a protective first render", (stored, expected) => {
		if (stored !== null) localStorage.setItem(key, stored);
		render(view());
		expect(screen.getByText(expected)).toBeInTheDocument();
		expect(rendered[0]).toBe(true);
	});
	it("remains masked when the initial storage read is denied", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("Synthetic denied", "SecurityError");
		});
		render(view());
		expect(screen.getByText("Masked")).toBeInTheDocument();
		expect(rendered.every(Boolean)).toBe(true);
	});
	it("keeps an explicit session-only choice when writing fails without a misleading storage sync event", () => {
		localStorage.setItem(key, "true");
		render(view());
		let synced = 0;
		const onSync = () => {
			synced += 1;
		};
		window.addEventListener("incognito-mode-changed", onSync);
		try {
			vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
				throw new DOMException("Synthetic denied", "SecurityError");
			});
			fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
			expect(screen.getByText("Visible")).toBeInTheDocument();
			expect(localStorage.getItem(key)).toBe("true");
			expect(synced).toBe(0);
		} finally {
			window.removeEventListener("incognito-mode-changed", onSync);
		}
	});
	it("preserves an explicit in-memory choice if a later custom-event storage read fails", () => {
		render(view());
		fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
		expect(screen.getByText("Masked")).toBeInTheDocument();
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("Synthetic denied", "SecurityError");
		});
		act(() => {
			window.dispatchEvent(new Event("incognito-mode-changed"));
		});
		expect(screen.getByText("Masked")).toBeInTheDocument();
	});
	it("persists explicit choices and synchronizes working custom and cross-tab events", () => {
		render(view());
		fireEvent.click(screen.getByRole("button", { name: "Toggle privacy" }));
		expect(localStorage.getItem(key)).toBe("true");
		expect(screen.getByText("Masked")).toBeInTheDocument();
		localStorage.setItem(key, "false");
		act(() => {
			window.dispatchEvent(new Event("incognito-mode-changed"));
		});
		expect(screen.getByText("Visible")).toBeInTheDocument();
		act(() => {
			window.dispatchEvent(new StorageEvent("storage", { key, newValue: "true" }));
		});
		expect(screen.getByText("Masked")).toBeInTheDocument();
	});
});
