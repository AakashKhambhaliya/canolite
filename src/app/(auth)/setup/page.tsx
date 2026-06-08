"use client";

import { useEffect, useState } from "react";
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
import { Loader2, Eye, EyeOff, Sparkles } from "lucide-react";
import { Logo } from "@/components/logo";

export default function SetupPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();

  // If already configured, there's nothing to set up — go to login.
  useEffect(() => {
    let active = true;
    fetch("/api/auth/setup")
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        if (d.configured) router.replace("/login");
        else setChecking(false);
      })
      .catch(() => active && setChecking(false));
    return () => {
      active = false;
    };
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Enter a valid email address");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch("/api/auth/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 409) {
          router.replace("/login");
          return;
        }
        setError(data.error || "Setup failed");
        return;
      }
      toast.success("Admin account created");
      router.push("/");
      router.refresh();
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  if (checking) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card className="border-0 shadow-xl bg-white dark:bg-gray-900">
      <CardHeader className="space-y-1 pb-4">
        <div className="flex items-center gap-2 mb-2 lg:hidden">
          <Logo size={32} className="rounded-lg" />
          <span className="text-lg font-bold">Canolite</span>
        </div>
        <CardTitle className="text-2xl font-bold flex items-center gap-2">
          <Sparkles className="h-6 w-6 text-blue-600" />
          Set up your admin account
        </CardTitle>
        <CardDescription>
          Create the owner account for this Canolite instance. You can change
          the password later from Settings.
        </CardDescription>
      </CardHeader>
      <form onSubmit={handleSubmit}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Admin email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error) setError(undefined);
              }}
              disabled={isLoading}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError(undefined);
                }}
                className="pr-10"
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
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm password</Label>
            <Input
              id="confirm"
              type={showPassword ? "text" : "password"}
              placeholder="Re-enter password"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value);
                if (error) setError(undefined);
              }}
              disabled={isLoading}
            />
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
            Create account & continue
          </Button>
          <p className="text-xs text-muted-foreground text-center leading-relaxed">
            This one-time setup runs only until an account exists. Single-admin,
            self-hosted — no public sign-up.
          </p>
        </CardFooter>
      </form>
    </Card>
  );
}
