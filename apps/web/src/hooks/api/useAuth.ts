'use client';

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CurrentUser } from "@arr/shared";
import { login, logout } from "../../lib/api-client";

interface LoginPayload {
  identifier: string;
  password: string;
}

export const useLoginMutation = () => {
  const queryClient = useQueryClient();

  return useMutation<CurrentUser, unknown, LoginPayload>({
    mutationFn: login,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
  });
};

export const useLogoutMutation = () => {
  const queryClient = useQueryClient();

  return useMutation<void, unknown, void>({
    mutationFn: logout,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["current-user"] });
    },
  });
};

