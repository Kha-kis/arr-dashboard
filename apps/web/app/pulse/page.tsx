import { Suspense } from "react";
import { PageLayout } from "../../src/components/layout";
import { PremiumPageLoading } from "../../src/components/layout/premium-components";
import { PulseClient } from "../../src/features/pulse/components/pulse-client";

const PulsePage = () => (
	<PageLayout gap="6">
		<Suspense fallback={<PremiumPageLoading />}>
			<PulseClient />
		</Suspense>
	</PageLayout>
);

export default PulsePage;
