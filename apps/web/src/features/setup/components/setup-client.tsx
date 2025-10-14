"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../../components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";
import { cn } from "../../../lib/utils";
import { PasswordSetup } from "./password-setup";
import { OIDCSetup } from "./oidc-setup";
import { PasskeySetup } from "./passkey-setup";

type SetupMethod = "password" | "oidc" | "passkey";

export const SetupClient = () => {
	const [activeMethod, setActiveMethod] = useState<SetupMethod>("password");

	return (
		<Card className="w-full max-w-2xl">
			<CardHeader>
				<CardTitle className="text-2xl">Welcome to Arr Control Center</CardTitle>
				<CardDescription>
					Create your admin account to get started. Choose your preferred authentication
					method below.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{/* Tab navigation */}
				<div className="flex items-center gap-2 border-b border-white/10 pb-4 mb-6">
					<Button
						type="button"
						variant={activeMethod === "password" ? "primary" : "ghost"}
						size="sm"
						onClick={() => setActiveMethod("password")}
						className={cn(
							"flex-1",
							activeMethod !== "password" && "text-white/60 hover:text-white",
						)}
					>
						Password
					</Button>
					<Button
						type="button"
						variant={activeMethod === "oidc" ? "primary" : "ghost"}
						size="sm"
						onClick={() => setActiveMethod("oidc")}
						className={cn(
							"flex-1",
							activeMethod !== "oidc" && "text-white/60 hover:text-white",
						)}
					>
						OIDC
					</Button>
					<Button
						type="button"
						variant={activeMethod === "passkey" ? "primary" : "ghost"}
						size="sm"
						onClick={() => setActiveMethod("passkey")}
						className={cn(
							"flex-1",
							activeMethod !== "passkey" && "text-white/60 hover:text-white",
						)}
					>
						Passkey
					</Button>
				</div>

				{/* Method-specific forms */}
				{activeMethod === "password" && <PasswordSetup />}
				{activeMethod === "oidc" && <OIDCSetup />}
				{activeMethod === "passkey" && <PasskeySetup />}
			</CardContent>
		</Card>
	);
};
