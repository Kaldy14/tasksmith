import { FormEvent, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { authClient } from "@/auth-client";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function getSafeNextPath(): string | undefined {
  const next = new URLSearchParams(window.location.search).get("next");
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/login")) return undefined;
  return next;
}

export function LoginPage() {
  const navigate = useNavigate();
  const nextPath = getSafeNextPath();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await authClient.signIn.email({ email, password, rememberMe: true });
      if (result.error) throw new Error(result.error.message ?? "Sign in failed");
      if (nextPath) {
        window.location.assign(nextPath);
        return;
      }
      await navigate({ to: "/" });
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Sign in failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-background px-4 text-foreground">
      <Card className="w-full max-w-sm border-border-strong bg-surface-1 shadow-2xl shadow-black/10 backdrop-blur-none">
        <CardHeader className="space-y-3">
          <BrandMark size="lg" />
          <div className="space-y-1">
            <CardTitle>Sign in to TaskSmith</CardTitle>
            <CardDescription className="text-sm">Use the bootstrap admin account for this deployment.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-4 text-sm" onSubmit={(event) => void onSubmit(event)}>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            {error ? (
              <p
                className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
                aria-live="polite"
              >
                {error}
              </p>
            ) : null}
            <Button className="w-full" type="submit" disabled={submitting}>
              {submitting ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
