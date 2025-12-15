import { AuthGate } from "@arr/web/components/auth/auth-gate";
import { HuntingClient } from "@arr/web/features/hunting/components/hunting-client";
import { PageLayout } from "@arr/web/components/layout";

const HuntingPage = () => (
	<AuthGate>
		<PageLayout maxWidth="7xl">
			<HuntingClient />
		</PageLayout>
	</AuthGate>
);

export default HuntingPage;
