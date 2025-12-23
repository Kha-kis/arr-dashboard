"use client";

import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	CardDescription,
} from "../../../components/ui/card";
import { Alert, AlertDescription } from "../../../components/ui";

/**
 * Account form state
 */
export type AccountFormState = {
	username: string;
	tmdbApiKey: string;
};

/**
 * Props for the AccountTab component
 */
interface AccountTabProps {
	/** Current user data */
	currentUser?: {
		username: string;
		createdAt: string;
		hasTmdbApiKey?: boolean;
	} | null;
	/** Account form state */
	accountForm: AccountFormState;
	/** Handler for account form changes */
	onAccountFormChange: (updater: (prev: AccountFormState) => AccountFormState) => void;
	/** Handler for account form submission */
	onAccountUpdate: (event: React.FormEvent<HTMLFormElement>) => void;
	/** Whether account update is pending */
	isUpdating: boolean;
	/** Update result */
	updateResult?: {
		success: boolean;
		message: string;
	} | null;
}

/**
 * Tab for managing account settings
 */
export const AccountTab = ({
	currentUser,
	accountForm,
	onAccountFormChange,
	onAccountUpdate,
	isUpdating,
	updateResult,
}: AccountTabProps) => {

	return (
		<div className="space-y-6">
			<div className="grid gap-6 md:grid-cols-[2fr,1fr]">
				<Card>
				<CardHeader>
					<CardTitle>Account Information</CardTitle>
					<CardDescription>Update your username and configure integrations.</CardDescription>
				</CardHeader>
				<CardContent>
					<form className="space-y-4" onSubmit={onAccountUpdate}>
						<div className="space-y-2">
							<label className="text-xs uppercase text-fg-muted">Username</label>
							<Input
								value={accountForm.username}
								onChange={(event) =>
									onAccountFormChange((prev) => ({
										...prev,
										username: event.target.value,
									}))
								}
								placeholder={currentUser?.username ?? ""}
							/>
							<p className="text-xs text-fg-muted">Current: {currentUser?.username}</p>
						</div>
						<div className="border-t border-border pt-4 mt-6">
							<h3 className="text-sm font-semibold text-fg mb-4">TMDB API Integration</h3>
							<div className="space-y-2">
								<label className="text-xs uppercase text-fg-muted">TMDB API Read Access Token</label>
								<Input
									type="password"
									value={accountForm.tmdbApiKey}
									onChange={(event) =>
										onAccountFormChange((prev) => ({
											...prev,
											tmdbApiKey: event.target.value,
										}))
									}
									placeholder={
										currentUser?.hasTmdbApiKey ? "••••••••••••••••" : "Enter your TMDB API Read Access Token"
									}
								/>
								<p className="text-xs text-fg-muted">
									{currentUser?.hasTmdbApiKey ? (
										<>TMDB token is configured. Enter a new token to update it.</>
									) : (
										<>
											Use the <strong>API Read Access Token</strong> (not API Key) from{" "}
											<a
												href="https://www.themoviedb.org/settings/api"
												target="_blank"
												rel="noopener noreferrer"
												className="text-sky-400 hover:underline"
											>
												themoviedb.org/settings/api
											</a>
											. It starts with &quot;eyJ...&quot;
										</>
									)}
								</p>
							</div>
						</div>
						<div className="flex gap-2">
							<Button type="submit" disabled={isUpdating}>
								{isUpdating ? "Saving..." : "Save changes"}
							</Button>
						</div>
						{updateResult && (
							<Alert variant={updateResult.success ? "success" : "danger"}>
								<AlertDescription>{updateResult.message}</AlertDescription>
							</Alert>
						)}
					</form>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Account Details</CardTitle>
					<CardDescription>Your current account information.</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-1">
						<p className="text-xs uppercase text-fg-muted">Created</p>
						<p className="text-sm text-fg">
							{currentUser?.createdAt ? new Date(currentUser.createdAt).toLocaleDateString() : "-"}
						</p>
					</div>
				</CardContent>
			</Card>
			</div>

		</div>
	);
};
