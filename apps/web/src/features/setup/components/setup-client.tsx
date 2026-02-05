"use client";

import { useState } from "react";
import { KeyRound, Lock, Zap } from "lucide-react";
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
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useSetupRequired } from "../../../hooks/api/useAuth";

type SetupMethod = "password" | "oidc" | "passkey";

export const SetupClient = () => {
	const { gradient: themeGradient } = useThemeGradient();
	const { data: setupData } = useSetupRequired();
	const [activeMethod, setActiveMethod] = useState<SetupMethod>("passkey");
	const passwordPolicy = setupData?.passwordPolicy ?? "strict";

	const methods = [
		{ id: "passkey" as const, label: "Passkey", icon: KeyRound },
		{ id: "password" as const, label: "Password", icon: Lock },
		{ id: "oidc" as const, label: "OIDC", icon: Zap },
	];

	return (
		<div className="w-full max-w-2xl space-y-6">
			{/* Header */}
			<div className="text-center space-y-2">
				<p className="text-sm uppercase tracking-[0.3em] text-muted-foreground">Arr Control Center</p>
				<h1
					className="text-3xl font-bold tracking-tight"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
						WebkitBackgroundClip: "text",
						WebkitTextFillColor: "transparent",
					}}
				>
					Welcome to your dashboard
				</h1>
				<p className="text-muted-foreground">
					Create your admin account to get started. Choose your preferred authentication method.
				</p>
			</div>

			{/* Setup Card */}
			<Card className="border-border/50 bg-card/80 backdrop-blur-xs">
				<CardHeader>
					<CardTitle className="text-xl text-foreground">Create Admin Account</CardTitle>
					<CardDescription className="text-muted-foreground">
						Select an authentication method and complete the setup to begin.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{/* Tab navigation */}
					<div className="flex items-center gap-2 border-b border-border/50 pb-4 mb-6">
						{methods.map((method) => {
							const Icon = method.icon;
							const isActive = activeMethod === method.id;
							return (
								<Button
									key={method.id}
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => setActiveMethod(method.id)}
									className={cn(
										"flex-1 gap-2 rounded-xl transition-all duration-200",
										isActive
											? "text-foreground"
											: "text-muted-foreground hover:text-foreground",
									)}
									style={
										isActive
											? {
													background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
													border: `1px solid ${themeGradient.from}30`,
												}
											: undefined
									}
								>
									<Icon
										className="h-4 w-4"
										style={isActive ? { color: themeGradient.from } : undefined}
									/>
									{method.label}
								</Button>
							);
						})}
					</div>

					{/* Method-specific forms */}
					{activeMethod === "passkey" && <PasskeySetup />}
					{activeMethod === "password" && <PasswordSetup passwordPolicy={passwordPolicy} />}
					{activeMethod === "oidc" && <OIDCSetup />}
				</CardContent>
			</Card>
		</div>
	);
};
