"use client";

import { useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { authClient } from "@/lib/auth/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Github, Loader2, Mail } from "lucide-react";
import Image from "next/image";

interface LoginFormProps {
  githubEnabled: boolean;
  registrationEnabled: boolean;
}

export function LoginForm({ githubEnabled, registrationEnabled }: LoginFormProps) {
  const [loading, setLoading] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const searchParams = useSearchParams();
  const router = useRouter();
  const urlError = searchParams.get("error");

  async function handleEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email || !password) {
      setError("Email and password are required.");
      return;
    }
    if (password.length < 8) {
      setError("The password must be at least 8 characters.");
      return;
    }
    if (isSignUp && !name.trim()) {
      setError("A name is required to sign up.");
      return;
    }

    setLoading(true);
    try {
      if (isSignUp) {
        const result = await authClient.signUp.email({
          email,
          password,
          name: name.trim(),
        });
        if (result.error) {
          // Use a single ambiguous message for all non-403 failures so the
          // client cannot distinguish "email already registered" (422) from
          // any other error — preventing account enumeration.
          const code = result.error.status;
          setError(
            code === 403
              ? "Sign-up is disabled on this server."
              : "Sign-up failed."
          );
          setLoading(false);
          return;
        }
      } else {
        const result = await authClient.signIn.email({
          email,
          password,
        });
        if (result.error) {
          setError("Email or password is incorrect.");
          setLoading(false);
          return;
        }
      }
      router.push("/");
    } catch {
      setError("An unexpected error occurred.");
      setLoading(false);
    }
  }

  const displayError = error ?? (urlError ? "Sign-in failed. Please try again." : null);

  return (
    <Card className="glass-card w-full max-w-sm">
      <CardHeader className="flex flex-col items-center text-center">
        <Image
          src="/logo_mybmad.png"
          alt="MyBMAD"
          width={64}
          height={64}
          className="mb-2"
        />
        <CardTitle className="text-2xl font-bold">MyBMAD</CardTitle>
        <CardDescription>
          {isSignUp ? "Create an account" : "Sign in to your dashboard"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {displayError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-center text-sm text-destructive">
            {displayError}
          </div>
        )}

        <form onSubmit={handleEmailSubmit} className="space-y-3">
          {isSignUp && (
            <Input
              placeholder="Nom"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={loading}
              autoComplete="name"
            />
          )}
          <Input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
            autoComplete="email"
          />
          <Input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            autoComplete={isSignUp ? "new-password" : "current-password"}
          />
          <Button type="submit" className="w-full" size="lg" disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            ) : (
              <Mail className="mr-2 h-5 w-5" />
            )}
            {isSignUp ? "Sign up" : "Sign in"}
          </Button>
        </form>

        {registrationEnabled && (
          <button
            type="button"
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => {
              setIsSignUp(!isSignUp);
              setError(null);
            }}
            disabled={loading}
          >
            {isSignUp
              ? "Already have an account? Sign in"
              : "No account? Sign up"}
          </button>
        )}

        {githubEnabled && (
          <>
            <div className="relative flex items-center py-1">
              <div className="flex-1 border-t border-border" />
              <span className="mx-3 text-xs text-muted-foreground">ou</span>
              <div className="flex-1 border-t border-border" />
            </div>
            <Button
              variant="outline"
              className="w-full"
              size="lg"
              disabled={loading}
              onClick={() => {
                setLoading(true);
                authClient.signIn.social({
                  provider: "github",
                  callbackURL: "/",
                  errorCallbackURL: "/login",
                });
              }}
            >
              {loading ? (
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              ) : (
                <Github className="mr-2 h-5 w-5" />
              )}
              Continue with GitHub
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
