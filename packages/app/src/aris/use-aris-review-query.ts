import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ArisReviewReadResponse } from "@getpaseo/protocol/messages";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useWorkspace } from "@/stores/session-store-hooks";

export function arisReviewQueryKey(serverId: string, workspaceId: string, runId?: string) {
  return ["aris", "review", serverId, workspaceId, runId ?? "__all__"] as const;
}

export interface UseArisReviewQueryInput {
  serverId: string;
  workspaceId: string;
  runId?: string;
  enabled?: boolean;
}

export type ArisReviewReadResult = ArisReviewReadResponse["payload"];

export function useArisReviewQuery(input: UseArisReviewQueryInput) {
  const { serverId, workspaceId, runId, enabled = true } = input;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const workspace = useWorkspace(serverId, workspaceId);
  const cwd = workspace?.workspaceDirectory ?? null;
  const queryKey = useMemo(
    () => arisReviewQueryKey(serverId, workspaceId, runId),
    [serverId, workspaceId, runId],
  );

  const query = useQuery<ArisReviewReadResult>({
    queryKey,
    enabled: Boolean(enabled && client && isConnected && cwd),
    staleTime: 30_000,
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      if (!cwd) {
        throw new Error("Workspace directory unavailable");
      }
      const response = await client.readArisReview({ cwd, runId });
      return response;
    },
  });

  useEffect(() => {
    if (!enabled || !client || !isConnected || !serverId || !workspaceId) {
      return;
    }

    return client.on("aris.review.update", (message) => {
      if (message.type !== "aris.review.update") {
        return;
      }
      void queryClient.invalidateQueries({ queryKey, type: "active", stale: true });
    });
  }, [client, enabled, isConnected, queryClient, queryKey, serverId, workspaceId]);

  const isQueryEnabled = Boolean(enabled && client && isConnected && cwd);
  return {
    data: query.data,
    // When the query is disabled (no cwd/client/connection), report
    // isLoading: false so consumers can render with empty data instead of
    // hanging on a spinner.
    isLoading: isQueryEnabled && query.isLoading,
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
  };
}
