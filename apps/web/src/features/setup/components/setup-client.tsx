"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "../../../lib/api-client/base";
import type { CurrentUser } from "@arr/shared";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { Alert, AlertDescription } from "../../../components/ui";
import { cn } from "../../../lib/utils";

interface RegisterResponse {
  user: CurrentUser;
}

export const SetupClient = () => {
  const router = useRouter();
  const [formState, setFormState] = useState({
    email: "",
    username: "",
    password: "",
    confirmPassword: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    // Validation
    if (!formState.email || !formState.username || !formState.password) {
      setError("All fields are required");
      return;
    }
    if (formState.password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (!/[a-z]/.test(formState.password)) {
      setError("Password must contain at least one lowercase letter");
      return;
    }
    if (!/[A-Z]/.test(formState.password)) {
      setError("Password must contain at least one uppercase letter");
      return;
    }
    if (!/[0-9]/.test(formState.password)) {
      setError("Password must contain at least one number");
      return;
    }
    if (!/[^a-zA-Z0-9]/.test(formState.password)) {
      setError("Password must contain at least one special character");
      return;
    }
    if (formState.password !== formState.confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setIsSubmitting(true);

    try {
      await apiRequest<RegisterResponse>("/auth/register", {
        method: "POST",
        json: {
          email: formState.email.trim(),
          username: formState.username.trim(),
          password: formState.password,
        },
      });

      // Registration successful, redirect to dashboard
      router.push("/dashboard");
    } catch (err: any) {
      setError(err.message ?? "Failed to create admin account");
      setIsSubmitting(false);
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle className="text-2xl">
          Welcome to Arr Control Center
        </CardTitle>
        <CardDescription>
          Create your admin account to get started. This will be the first user
          with full administrative access.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label className="text-xs uppercase text-white/60">Email</label>
            <Input
              type="email"
              value={formState.email}
              onChange={(e) =>
                setFormState((prev) => ({ ...prev, email: e.target.value }))
              }
              placeholder="admin@example.com"
              required
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase text-white/60">Username</label>
            <Input
              type="text"
              value={formState.username}
              onChange={(e) =>
                setFormState((prev) => ({ ...prev, username: e.target.value }))
              }
              placeholder="admin"
              required
              minLength={3}
              maxLength={50}
            />
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase text-white/60">Password</label>
            <Input
              type="password"
              value={formState.password}
              onChange={(e) =>
                setFormState((prev) => ({ ...prev, password: e.target.value }))
              }
              placeholder="At least 8 characters"
              required
              minLength={8}
            />
            <p className="text-xs text-white/50">
              Must include uppercase, lowercase, number, and special character
            </p>
          </div>
          <div className="space-y-2">
            <label className="text-xs uppercase text-white/60">
              Confirm Password
            </label>
            <Input
              type="password"
              value={formState.confirmPassword}
              onChange={(e) =>
                setFormState((prev) => ({
                  ...prev,
                  confirmPassword: e.target.value,
                }))
              }
              placeholder="Re-enter password"
              required
            />
          </div>
          {error && (
            <Alert variant="danger">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={isSubmitting} className="w-full">
            {isSubmitting ? "Creating account..." : "Create Admin Account"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};
