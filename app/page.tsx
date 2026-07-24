import { Dashboard } from "@/components/dashboard";
import { resolveSlateDate } from "@/lib/mlb";

export const dynamic = "force-dynamic";

export default async function Page() {
  const date = await resolveSlateDate();
  return <Dashboard initialDate={date} />;
}
