import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider } from "next-themes";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../providers/color-theme-provider";
import { CommandPalette, useCommandPalette } from "../command-palette";

const { push, logout } = vi.hoisted(() => ({ push: vi.fn(), logout: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("../../../lib/api-client/auth", () => ({ logout }));

function Harness() {
	const { open, setOpen } = useCommandPalette();
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open commands
			</button>
			<CommandPalette open={open} onOpenChange={setOpen} />
		</>
	);
}
let client: QueryClient;
beforeEach(() => {
	localStorage.clear();
	document.documentElement.removeAttribute("data-oled");
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({ matches: true, addListener() {}, removeListener() {} })),
	);
	Object.defineProperty(Element.prototype, "scrollIntoView", {
		value: vi.fn(),
		configurable: true,
	});
	logout.mockResolvedValue(undefined);
});
afterEach(() => {
	cleanup();
	client.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});
function Providers({ children }: PropsWithChildren) {
	return (
		<QueryClientProvider client={client}>
			<ThemeProvider forcedTheme="dark">
				<ColorThemeProvider>
					<IncognitoProvider>{children}</IncognitoProvider>
				</ColorThemeProvider>
			</ThemeProvider>
		</QueryClientProvider>
	);
}
function mount(content = <Harness />) {
	return render(content, { wrapper: Providers });
}
async function open() {
	const opener = screen.getByRole("button", { name: "Open commands" });
	opener.focus();
	fireEvent.keyDown(opener, { key: "k", ctrlKey: true });
	const input = await screen.findByPlaceholderText("Type a command or search...");
	await waitFor(() => expect(input).toHaveFocus());
	return { opener, input };
}

describe("Command palette modal", () => {
	it("uses the current close callback once after replacement while open", () => {
		const first = vi.fn();
		const second = vi.fn();
		const view = mount(<CommandPalette open onOpenChange={first} />);
		view.rerender(<CommandPalette open onOpenChange={second} />);
		const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		act(() => window.dispatchEvent(escape));
		expect(escape.defaultPrevented).toBe(true);
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledExactlyOnceWith(false);
	});

	it("owns Escape before underlying document capture handlers", async () => {
		mount();
		const { opener, input } = await open();
		const underlying = vi.fn();
		document.addEventListener("keydown", underlying, true);
		try {
			const escape = new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			});
			act(() => input.dispatchEvent(escape));
			expect(escape.defaultPrevented).toBe(true);
			expect(underlying).not.toHaveBeenCalled();
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
			await waitFor(() => expect(opener).toHaveFocus());
		} finally {
			document.removeEventListener("keydown", underlying, true);
		}
	});

	it("leaves non-Escape and previously handled Escape alone", async () => {
		mount();
		const { input } = await open();
		const underlying = vi.fn();
		document.addEventListener("keydown", underlying, true);
		try {
			const other = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
			act(() => input.dispatchEvent(other));
			expect(other.defaultPrevented).toBe(false);
			expect(underlying).toHaveBeenCalledOnce();
			const handled = new KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			});
			handled.preventDefault();
			act(() => input.dispatchEvent(handled));
			expect(underlying).toHaveBeenCalledTimes(2);
			expect(input).toBeInTheDocument();
		} finally {
			document.removeEventListener("keydown", underlying, true);
		}
	});

	it("releases Escape ownership on close and unmount", async () => {
		const view = mount();
		await open();
		fireEvent.click(screen.getByRole("option", { name: "Refresh All Data" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		const closedEscape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		window.dispatchEvent(closedEscape);
		expect(closedEscape.defaultPrevented).toBe(false);
		await open();
		view.unmount();
		const unmountedEscape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		window.dispatchEvent(unmountedEscape);
		expect(unmountedEscape.defaultPrevented).toBe(false);
	});

	it("closes on Escape from the real focused command input and restores its keyboard opener", async () => {
		mount();
		const { opener, input } = await open();
		fireEvent.keyDown(input, { key: "Escape" });
		await waitFor(() =>
			expect(screen.queryByPlaceholderText("Type a command or search...")).not.toBeInTheDocument(),
		);
		await waitFor(() => expect(opener).toHaveFocus());
	});
	it("names its modal, contains forward and reverse Tab, and dismisses outside", async () => {
		mount();
		const { opener, input } = await open();
		const dialog = screen.getByRole("dialog", { name: "Command palette" });
		opener.focus();
		expect(input).toHaveFocus();
		fireEvent.keyDown(input, { key: "Tab" });
		expect(input).toHaveFocus();
		fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
		expect(input).toHaveFocus();
		fireEvent.pointerDown(dialog.previousElementSibling!, { button: 0, ctrlKey: false });
		fireEvent.click(dialog.previousElementSibling!, { button: 0, ctrlKey: false });
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
		await waitFor(() => expect(opener).toHaveFocus());
	});
	it("releases scroll and inertness when unmounted while open", async () => {
		const view = mount();
		await open();
		expect(document.body).toHaveAttribute("data-scroll-locked");
		view.unmount();
		await waitFor(() => expect(document.body.style.pointerEvents).toBe(""));
		expect(document.body).not.toHaveAttribute("data-scroll-locked");
	});
	it("opens documentation at the canonical repository and resets the next search", async () => {
		const external = vi.spyOn(window, "open").mockReturnValue(null);
		mount();
		const { input } = await open();
		fireEvent.change(input, { target: { value: "documentation" } });
		fireEvent.click(await screen.findByRole("option", { name: "Documentation" }));
		expect(external).toHaveBeenCalledExactlyOnceWith(
			"https://github.com/Kha-kis/arr-dashboard",
			"_blank",
		);
		await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument());
		const reopened = await open();
		expect(reopened.input).toHaveValue("");
	});
	it("retains search and keyboard selection for navigation", async () => {
		mount();
		const { input } = await open();
		fireEvent.change(input, { target: { value: "calendar" } });
		await screen.findByRole("option", { name: /Calendar/ });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(push).toHaveBeenCalledWith("/calendar");
		await waitFor(() => expect(screen.queryByRole("option")).not.toBeInTheDocument());
	});
	it("retains refresh, theme, OLED, and sign-out actions", async () => {
		const invalidate = vi.spyOn(client, "invalidateQueries");
		mount();
		await open();
		fireEvent.click(screen.getByRole("option", { name: "Refresh All Data" }));
		expect(invalidate).toHaveBeenCalledOnce();
		await open();
		fireEvent.click(screen.getByRole("option", { name: "Emerald" }));
		expect(document.documentElement).toHaveAttribute("data-theme", "green");
		await open();
		fireEvent.click(screen.getByRole("option", { name: /OLED Mode/ }));
		expect(document.documentElement).toHaveAttribute("data-oled", "true");
		await open();
		fireEvent.click(screen.getByRole("option", { name: "Light Mode" }));
		expect(localStorage.getItem("theme")).toBe("light");
		client.setQueryData(["synthetic"], "cached");
		await open();
		fireEvent.click(screen.getByRole("option", { name: "Log Out" }));
		await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
		expect(logout).toHaveBeenCalledOnce();
		expect(client.getQueryData(["synthetic"])).toBeUndefined();
	});
});
