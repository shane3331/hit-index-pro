import { Dashboard } from "@/components/dashboard";
import { isoDateInNewYork } from "@/lib/date";

export default function Page() {
  return <Dashboard initialDate={isoDateInNewYork(1)} />;
}
