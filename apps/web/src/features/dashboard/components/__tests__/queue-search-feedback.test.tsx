import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { QueueSearchFeedback } from "../queue-search-feedback";

it("renders generic persistent partial feedback and navigation-only recovery with dismissal", () => {
	const dismiss = vi.fn(),
		fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	const view = render(
		<IncognitoProvider>
			<QueueSearchFeedback warning="unconfirmed" onDismiss={dismiss} />
		</IncognitoProvider>,
	);
	expect(screen.getByRole("alert")).toHaveTextContent(/removed.*search.*not confirmed/i);
	expect(screen.getByRole("link", { name: "Open Library" })).toHaveAttribute("href", "/library");
	expect(screen.getByRole("alert")).toHaveTextContent(/review.*current.*library/i);
	expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
	expect(fetch).not.toHaveBeenCalled();
	fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
	expect(dismiss).toHaveBeenCalledOnce();
	view.unmount();
	vi.unstubAllGlobals();
});
it("does not claim removal when the response is unverified", () => {
	const view = render(
		<IncognitoProvider>
			<QueueSearchFeedback warning="unverified" onDismiss={() => {}} />
		</IncognitoProvider>,
	);
	expect(screen.getByRole("alert")).toHaveTextContent(/could not be verified/i);
	expect(screen.getByRole("alert")).not.toHaveTextContent(/items? (?:was |were )?removed/i);
	view.unmount();
});
