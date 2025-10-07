"use client";

import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../../../components/ui/card";

/**
 * Card displayed when no Prowlarr instances are configured
 * @returns React component showing empty state
 */
export const EmptyIndexersCard = () => {
	return (
		<Card className="border-dashed border-white/20 bg-white/5">
			<CardHeader>
				<CardTitle className="text-xl">No Prowlarr instances configured</CardTitle>
				<CardDescription>
					Add a Prowlarr service in Settings to manage indexers from this dashboard.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<p className="text-sm text-white/70">
					Once a Prowlarr instance is enabled, its indexers will appear here automatically.
				</p>
			</CardContent>
		</Card>
	);
};
