import { CustomFormatsClient } from "../../src/features/custom-formats/components/custom-formats-client";

export default function CustomFormatsPage() {
	return (
		<div className="container mx-auto py-6 space-y-6">
			<div>
				<h1 className="text-3xl font-bold tracking-tight text-fg">
					Custom Formats
				</h1>
				<p className="text-fg-muted mt-2">
					Manage custom formats across all your Sonarr and Radarr instances
				</p>
			</div>

			<CustomFormatsClient />
		</div>
	);
}
