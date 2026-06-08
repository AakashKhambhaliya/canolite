import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";

// Auth-gated — always server-rendered per request (reads the session cookie).
export const dynamic = "force-dynamic";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return <DashboardShell user={user}>{children}</DashboardShell>;
}
