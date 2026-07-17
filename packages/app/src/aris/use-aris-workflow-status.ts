import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ArisWorkflowStatusReadResponse } from "@getpaseo/protocol/messages";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export function arisWorkflowStatusQueryKey(serverId: string, workspaceId: string) {
  return ["aris", "workflow-status", serverId, workspaceId] as const;
}

export type ArisWorkflowStatusResult = ArisWorkflowStatusReadResponse["payload"];

/**
 * Reads the ARIS W1-W6 workflow status for a workspace. Mirrors
 * `useArisReviewQuery`: react-query with a short stale time, invalidated by the
 * `aris.workflow.update` push (WT1) and `aris.iteration_log.update` (WT2, since
 * run-state-derived status can shift when iterations land).
 */
export function useArisWorkflowStatus(serverId: string, workspaceId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryKey = useMemo(
    () => arisWorkflowStatusQueryKey(serverId, workspaceId),
    [serverId, workspaceId],
  );

  const query = useQuery<ArisWorkflowStatusResult>({
    queryKey,
    enabled: Boolean(client && isConnected && serverId && workspaceId),
    staleTime: 10_000,
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      return client.readArisWorkflowStatus(workspaceId);
    },
  });

  useEffect(() => {
    if (!client || !isConnected || !serverId || !workspaceId) {
      return;
    }

    const invalidate = () => {
      void queryClient.invalidateQueries({ queryKey, type: "active", stale: true });
    };

    const offWorkflow = client.on("aris.workflow.update", (message) => {
      if (message.type !== "aris.workflow.update") {
        return;
      }
      invalidate();
    });
    const offIteration = client.on("aris.iteration_log.update", (message) => {
      if (message.type !== "aris.iteration_log.update") {
        return;
      }
      invalidate();
    });

    return () => {
      offWorkflow();
      offIteration();
    };
  }, [client, isConnected, queryClient, queryKey, serverId, workspaceId]);

  const isQueryEnabled = Boolean(client && isConnected && serverId && workspaceId);
  return {
    data: query.data,
    // When the query is disabled (no client/connection/workspace), report
    // isLoading: false so consumers can render with empty data instead of
    // hanging on a spinner.
    isLoading: isQueryEnabled && query.isLoading,
    isError: query.isError,
    error: query.error instanceof Error ? query.error.message : null,
  };
}
