import { toast } from "../../../components/ui/toast";

export function showMonitoringUnconfirmedToast(): void {
	toast.error("Monitoring update not confirmed", {
		description: "Reload Library to check the current state before trying again.",
	});
}
