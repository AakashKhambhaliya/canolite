"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "sonner";
import { Loader2, Eye, EyeOff, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/logo";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();

  // First run? Send the operator to the setup wizard instead.
  useEffect(() => {
    let active = true;
    fetch("/api/auth/setup")
      .then((r) => r.json())
      .then((d) => {
        if (active && !d.configured) router.replace("/setup");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError("Email and password are required");
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        if (res.status === 409) {
          router.replace("/setup");
          return;
        }
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Invalid email or password");
        toast.error(data.error || "Invalid email or password");
        return;
      }

      // The response above carried the session cookie. Confirm the browser
      // actually kept it BEFORE navigating: if it didn't, the dashboard bounces
      // straight back here and the user is stuck staring at a login page that
      // keeps telling them the login worked. The usual cause is a `Secure`
      // cookie on a plain-HTTP origin — a proxy sending X-Forwarded-Proto:
      // https while the browser is talking to the app over http://.
      const check = await fetch("/api/auth/me", { cache: "no-store" });
      if (!check.ok) {
        const msg =
          "Signed in, but your browser didn't keep the session cookie. " +
          "If you're using plain HTTP behind a proxy, make sure it isn't " +
          "sending X-Forwarded-Proto: https — or open the app over HTTPS.";
        setError(msg);
        toast.error(msg);
        return;
      }

      toast.success("Welcome back!");
      // Hard navigation, not router.push(): it re-runs middleware and the
      // server layout against the cookie the browser actually holds, with no
      // client-side router cache in the way.
      window.location.replace("/");
    } catch (err) {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="border-0 shadow-xl bg-white dark:bg-gray-900">
      <CardHeader className="space-y-1 pb-4">
        <div className="flex items-center gap-2 mb-2 lg:hidden">
          <Logo size={32} className="rounded-lg" />
          <span className="text-lg font-bold">Canolite</span>
        </div>
        <CardTitle className="text-2xl font-bold flex items-center gap-2">
          <ShieldCheck className="h-6 w-6 text-blue-600" />
          Admin sign in
        </CardTitle>
        <CardDescription>
          Enter the admin password to access this Canolite instance.
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Admin email</Label>
            <Input
              id="email"
              type="email"
              placeholder="admin@example.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error) setError(undefined);
              }}
              className={error ? "border-destructive" : ""}
              disabled={isLoading}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Admin password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                placeholder="••••••••"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError(undefined);
                }}
                className={error ? "border-destructive pr-10" : "pr-10"}
                disabled={isLoading}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                tabIndex={-1}
              >
                {showPassword ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </CardContent>
        <CardFooter className="flex flex-col gap-4">
          <Button
            type="submit"
            className="w-full"
            variant="accent"
            disabled={isLoading}
          >
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Sign in
          </Button>
          <p className="text-xs text-muted-foreground text-center leading-relaxed">
            Single-admin, self-hosted — no public sign-up. Change your password
            anytime from Settings.
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
