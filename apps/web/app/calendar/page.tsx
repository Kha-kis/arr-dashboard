import { PageLayout } from "../../src/components/layout";
import { CalendarClient } from "../../src/features/calendar/components/calendar-client";

const CalendarPage = () => (
	<PageLayout gap="6" className="max-w-[1600px]">
		<CalendarClient />
	</PageLayout>
);

export default CalendarPage;
