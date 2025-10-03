'use client';

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../lib/api-client/base";
import type { CurrentUser } from "@arr/shared";

interface UpdateAccountPayload {
  email?: string;
  username?: string;
  currentPassword?: string;
  newPassword?: string;
}

interface UpdateAccountResponse {
  user: CurrentUser;
}

const updateAccount = async (payload: UpdateAccountPayload): Promise<UpdateAccountResponse> => {
  return await apiRequest<UpdateAccountResponse>("/auth/account", {
    method: "PATCH",
    json: payload,
  });
};

export const useUpdateAccountMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: updateAccount,
    onSuccess: (data) => {
      // Update the current user in the cache
      queryClient.setQueryData(["current-user"], data.user);
    },
  });
};
