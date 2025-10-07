"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useCurrentUser, useSetupRequired, useLoginMutation } from "../../../hooks/api/useAuth";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { Alert, AlertDescription } from "../../../components/ui";

const DEFAULT_REDIRECT = "/dashboard";

const sanitizeRedirect = (value: string | null): string => {
	if (!value) {
		return DEFAULT_REDIRECT;
	}
	if (!value.startsWith("/")) {
		return DEFAULT_REDIRECT;
	}
	try {
		const url = new URL(value, "http://localhost");
		return `${url.pathname}${url.search}`;
	} catch (_error) {
		return DEFAULT_REDIRECT;
	}
};

export const LoginForm = () => {
	const router = useRouter();
	const searchParams = useSearchParams();
	const loginMutation = useLoginMutation();

	const [identifier, setIdentifier] = useState("");
	const [password, setPassword] = useState("");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const redirectTarget = useMemo(
		() => sanitizeRedirect(searchParams?.get("redirectTo") ?? null),
		[searchParams],
	);

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setErrorMessage(null);

		const trimmedIdentifier = identifier.trim();
		if (trimmedIdentifier.length === 0) {
			setErrorMessage("Please enter your username or email.");
			return;
		}

		try {
			await loginMutation.mutateAsync({
				identifier: trimmedIdentifier,
				password,
			});
			setPassword("");
			router.replace(redirectTarget);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "Unable to sign in. Please verify your credentials and try again.";
			setErrorMessage(message);
		}
	};

	const disabled = loginMutation.isPending;

	return (
		<div className="flex min-h-[60vh] flex-col items-center justify-center gap-6">
			<div className="text-center">
				<p className="text-sm uppercase tracking-[0.3em] text-white/50">Arr Control Center</p>
				<h1 className="mt-2 text-3xl font-semibold text-white">Sign in to your dashboard</h1>
				<p className="mt-2 text-sm text-white/60">Use your admin credentials to continue.</p>
			</div>

			<Card className="w-full max-w-sm border-white/10 bg-white/5">
				<CardHeader>
					<CardTitle className="text-xl text-white">Welcome back</CardTitle>
					<CardDescription className="text-white/60">
						Enter your username or email with the password you configured for this instance.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form className="space-y-5" onSubmit={handleSubmit} autoComplete="off">
						<div className="space-y-2">
							<label className="block text-xs font-semibold uppercase tracking-wide text-white/60">
								Username or email
							</label>
							<Input
								value={identifier}
								onChange={(event) => setIdentifier(event.target.value)}
								placeholder="Enter your username"
								autoComplete="off"
								required
							/>
						</div>

						<div className="space-y-2">
							<label className="block text-xs font-semibold uppercase tracking-wide text-white/60">
								Password
							</label>
							<Input
								type="password"
								value={password}
								onChange={(event) => setPassword(event.target.value)}
								placeholder="Enter your password"
								autoComplete="off"
								required
							/>
						</div>

						{errorMessage && (
							<Alert variant="danger">
								<AlertDescription>{errorMessage}</AlertDescription>
							</Alert>
						)}

						<Button className="w-full" type="submit" disabled={disabled}>
							{loginMutation.isPending ? "Signing in..." : "Sign in"}
						</Button>
					</form>
				</CardContent>
			</Card>

			<p className="text-xs text-white/40">
				Need to configure services? Head over to{" "}
				<Link href="/settings" className="text-white/70 underline hover:text-white">
					Settings
				</Link>{" "}
				after signing in.
			</p>
		</div>
	);
};
