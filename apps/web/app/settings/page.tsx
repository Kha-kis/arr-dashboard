import { SettingsClient } from "../../src/features/settings/components/settings-client";
import { PageLayout, PageHeader } from "../../src/components/layout";

const SettingsPage = () => (
	<PageLayout>
		<PageHeader
			title="Settings"
			description="Manage Sonarr, Radarr, and Prowlarr connections, organise instances with tags, and ensure the right defaults are applied across the dashboard."
		/>
		<SettingsClient />
	</PageLayout>
);

export default SettingsPage;
