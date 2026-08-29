import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { BackupEncryptionSection } from "../backup-encryption-section";

const status = vi.hoisted(() => ({
	value: {
		configured: false,
		source: "database" as const,
		reason: "invalid_database_password" as const,
	},
}));

vi.mock("../../../../hooks/api/useBackup", () => ({
	useBackupPasswordStatus: () => ({ data: status.value, isLoading: false }),
	useRemoveBackupPassword: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useSetBackupPassword: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

describe("BackupEncryptionSection", () => {
	it("explains that an undecryptable stored password needs a reset", () => {
		render(
			<ColorThemeProvider>
				<BackupEncryptionSection />
			</ColorThemeProvider>,
		);

		expect(screen.getByText("Password Needs Reset")).toBeInTheDocument();
		expect(screen.getByText(/stored password cannot be decrypted/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reset Password" })).toBeInTheDocument();
		expect(screen.queryByText("Password Configured")).not.toBeInTheDocument();
	});
});
