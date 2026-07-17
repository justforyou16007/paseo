import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ArisEventsReadResponse } from "@getpaseo/protocol/messages";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useWorkspace } from "@/stores/session-store-hooks";

export function arisEventsQueryKey(serverId: string, workspaceId: string, runId?: string) {
  return ["aris", "events", serverId, workspaceId, runId ?? "__all__"] as const;
}

export interface UseArisEventsQueryInput {
  serverId: string;
  workspaceId: string;
  runId?: string;
  limit?: number;
  enabled?: boolean;
}

export type ArisEventsReadResult = ArisEventsReadResponse["payload"];

export function useArisEventsQuery(input: UseArisEventsQueryInput) {
  const { serverId, workspaceId, runId, limit = 200, enabled = true } = input;
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const workspace = useWorkspace(serverId, workspaceId);
  const cwd = workspace?.workspaceDirectory ?? null;
  const queryKey = useMemo(
    () => arisEventsQueryKey(serverId, workspaceId, runId),
    [serverId, workspaceId, runId],
  );

  const query = useQuery<ArisEventsReadResult>({
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
      const response = await client.readArisEvents({ cwd, limit, runId });
      return response;
    },
  });

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
