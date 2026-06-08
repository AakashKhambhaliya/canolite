"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutGrid,
  Image,
  Key,
  Play,
  FileSpreadsheet,
  BookOpen,
  Settings,
  LogOut,
  ChevronLeft,
  User,
  Menu,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { Logo } from "@/components/logo";
import { UpdateChecker } from "@/components/dashboard/update-checker";

interface DashboardShellProps {
  children: React.ReactNode;
  user: {
    id: string;
    name: string | null;
    email: string;
    projectId: string;
  };
}

const NAV_ITEMS = [
  { href: "/", label: "Templates", icon: LayoutGrid },
  { href: "/renders", label: "Renders", icon: Image },
  { href: "/keys", label: "API Keys", icon: Key },
  { href: "/playground", label: "Playground", icon: Play },
  { href: "/bulk", label: "Bulk CSV", icon: FileSpreadsheet },
  { href: "/docs", label: "API Docs", icon: BookOpen },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function DashboardShell({ children, user }: DashboardShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      router.push("/login");
      router.refresh();
    } catch {
      toast.error("Failed to log out");
    }
  };

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/" || pathname === "/templates";
    return pathname.startsWith(href);
  };

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen overflow-hidden bg-gray-50 dark:bg-gray-950">
        {/* Mobile overlay */}
        {mobileOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}

        {/* Sidebar */}
        <aside
          className={cn(
            "fixed lg:static inset-y-0 left-0 z-50 flex flex-col bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 transition-all duration-300",
            collapsed ? "w-[68px]" : "w-[240px]",
            mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
          )}
        >
          {/* Logo */}
          <div className="h-16 flex items-center justify-between px-4 border-b border-gray-200 dark:border-gray-800">
            <Link href="/" className="flex items-center gap-2.5 min-w-0">
              <Logo size={32} className="shrink-0 rounded-lg" />
              {!collapsed && (
                <span className="text-lg font-bold tracking-tight truncate">
                  Canolite
                </span>
              )}
            </Link>
            <Button
              variant="ghost"
              size="icon-sm"
              className="hidden lg:flex shrink-0"
              onClick={() => setCollapsed(!collapsed)}
            >
              <ChevronLeft
                className={cn(
                  "h-4 w-4 transition-transform",
                  collapsed && "rotate-180"
                )}
              />
            </Button>
          </div>

          {/* Nav */}
          <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.href);
              const NavIcon = item.icon;

              const linkContent = (
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors group",
                    active
                      ? "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400"
                      : "text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800"
                  )}
                  onClick={() => setMobileOpen(false)}
                >
                  <NavIcon
                    className={cn(
                      "h-5 w-5 shrink-0",
                      active
                        ? "text-blue-600 dark:text-blue-400"
                        : "text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300"
                    )}
                  />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              );

              if (collapsed) {
                return (
                  <Tooltip key={item.href}>
                    <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
                    <TooltipContent side="right">
                      <p>{item.label}</p>
                    </TooltipContent>
                  </Tooltip>
                );
              }

              return (
                <div key={item.href}>{linkContent}</div>
              );
            })}
          </nav>

          {/* Update checker */}
          <div className="border-t border-gray-200 dark:border-gray-800 pt-2">
            <UpdateChecker collapsed={collapsed} />
          </div>

          {/* User menu */}
          <div className="border-t border-gray-200 dark:border-gray-800 p-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-lg w-full text-left hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors",
                    collapsed && "justify-center px-0"
                  )}
                >
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white text-xs font-bold shrink-0">
                    {user.name?.[0]?.toUpperCase() || user.email[0].toUpperCase()}
                  </div>
                  {!collapsed && (
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">
                        {user.name || "User"}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {user.email}
                      </p>
                    </div>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>
                  <p className="font-medium">{user.name || "User"}</p>
                  <p className="text-xs text-muted-foreground font-normal">
                    {user.email}
                  </p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings">
                    <Settings className="mr-2 h-4 w-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleLogout}
                  className="text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Mobile header */}
          <div className="lg:hidden flex items-center h-14 px-4 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-2 ml-3">
              <Logo size={28} className="rounded-lg" />
              <span className="font-bold">Canolite</span>
            </div>
          </div>

          {/* Page content */}
          <div className="flex-1 overflow-auto">{children}</div>
        </main>
      </div>
    </TooltipProvider>
  );
}
