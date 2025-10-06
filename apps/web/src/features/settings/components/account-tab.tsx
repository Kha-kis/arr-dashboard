"use client";

import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../../components/ui/card";
import { Alert, AlertDescription } from "../../../components/ui";

/**
 * Account form state
 */
export type AccountFormState = {
  email: string;
  username: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  tmdbApiKey: string;
};

/**
 * Props for the AccountTab component
 */
interface AccountTabProps {
  /** Current user data */
  currentUser?: {
    email: string;
    username: string;
    role: string;
    createdAt: string;
    hasTmdbApiKey?: boolean;
  } | null;
  /** Account form state */
  accountForm: AccountFormState;
  /** Handler for account form changes */
  onAccountFormChange: (
    updater: (prev: AccountFormState) => AccountFormState,
  ) => void;
  /** Handler for account form submission */
  onAccountUpdate: (event: React.FormEvent<HTMLFormElement>) => void;
  /** Whether account update is pending */
  isUpdating: boolean;
  /** Update result */
  updateResult?: {
    success: boolean;
    message: string;
  } | null;
}

/**
 * Tab for managing account settings
 */
export const AccountTab = ({
  currentUser,
  accountForm,
  onAccountFormChange,
  onAccountUpdate,
  isUpdating,
  updateResult,
}: AccountTabProps) => {
  return (
    <div className="grid gap-6 md:grid-cols-[2fr,1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Account Information</CardTitle>
          <CardDescription>
            Update your email, username, or password.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onAccountUpdate}>
            <div className="space-y-2">
              <label className="text-xs uppercase text-white/60">Email</label>
              <Input
                type="email"
                value={accountForm.email}
                onChange={(event) =>
                  onAccountFormChange((prev) => ({
                    ...prev,
                    email: event.target.value,
                  }))
                }
                placeholder={currentUser?.email ?? ""}
              />
              <p className="text-xs text-white/40">
                Current: {currentUser?.email}
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-xs uppercase text-white/60">
                Username
              </label>
              <Input
                value={accountForm.username}
                onChange={(event) =>
                  onAccountFormChange((prev) => ({
                    ...prev,
                    username: event.target.value,
                  }))
                }
                placeholder={currentUser?.username ?? ""}
              />
              <p className="text-xs text-white/40">
                Current: {currentUser?.username}
              </p>
            </div>
            <div className="border-t border-white/10 pt-4 mt-6">
              <h3 className="text-sm font-semibold text-white mb-4">
                Change Password
              </h3>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs uppercase text-white/60">
                    Current Password
                  </label>
                  <Input
                    type="password"
                    value={accountForm.currentPassword}
                    onChange={(event) =>
                      onAccountFormChange((prev) => ({
                        ...prev,
                        currentPassword: event.target.value,
                      }))
                    }
                    placeholder="Enter current password"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-xs uppercase text-white/60">
                    New Password
                  </label>
                  <Input
                    type="password"
                    value={accountForm.newPassword}
                    onChange={(event) =>
                      onAccountFormChange((prev) => ({
                        ...prev,
                        newPassword: event.target.value,
                      }))
                    }
                    placeholder="At least 8 characters"
                  />
                  <p className="text-xs text-white/50">
                    Must include uppercase, lowercase, number, and special
                    character
                  </p>
                </div>
                <div className="space-y-2">
                  <label className="text-xs uppercase text-white/60">
                    Confirm New Password
                  </label>
                  <Input
                    type="password"
                    value={accountForm.confirmPassword}
                    onChange={(event) =>
                      onAccountFormChange((prev) => ({
                        ...prev,
                        confirmPassword: event.target.value,
                      }))
                    }
                    placeholder="Re-enter new password"
                  />
                </div>
              </div>
            </div>
            <div className="border-t border-white/10 pt-4 mt-6">
              <h3 className="text-sm font-semibold text-white mb-4">
                TMDB API Integration
              </h3>
              <div className="space-y-2">
                <label className="text-xs uppercase text-white/60">
                  TMDB API Key
                </label>
                <Input
                  type="password"
                  value={accountForm.tmdbApiKey}
                  onChange={(event) =>
                    onAccountFormChange((prev) => ({
                      ...prev,
                      tmdbApiKey: event.target.value,
                    }))
                  }
                  placeholder={
                    currentUser?.hasTmdbApiKey
                      ? "••••••••••••••••"
                      : "Enter your TMDB API key"
                  }
                />
                <p className="text-xs text-white/50">
                  {currentUser?.hasTmdbApiKey ? (
                    <>
                      TMDB API key is configured. Enter a new key to update it.
                    </>
                  ) : (
                    <>
                      Get your free API key from{" "}
                      <a
                        href="https://www.themoviedb.org/settings/api"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sky-400 hover:underline"
                      >
                        themoviedb.org/settings/api
                      </a>
                    </>
                  )}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button type="submit" disabled={isUpdating}>
                {isUpdating ? "Saving..." : "Save changes"}
              </Button>
            </div>
            {updateResult && (
              <Alert variant={updateResult.success ? "success" : "danger"}>
                <AlertDescription>{updateResult.message}</AlertDescription>
              </Alert>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account Details</CardTitle>
          <CardDescription>Your current account information.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-xs uppercase text-white/60">Role</p>
            <p className="text-sm text-white capitalize">
              {currentUser?.role.toLowerCase()}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs uppercase text-white/60">Created</p>
            <p className="text-sm text-white">
              {currentUser?.createdAt
                ? new Date(currentUser.createdAt).toLocaleDateString()
                : "-"}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
