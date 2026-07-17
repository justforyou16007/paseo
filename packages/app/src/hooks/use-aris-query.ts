import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ArisRunState, ArisIteration } from "@getpaseo/protocol/messages";

export function arisRunsQueryKey(serverId: string, workspaceId: string) {
  return ["aris", "runs", serverId, workspaceId] as const;
}

export function arisRunQueryKey(serverId: string, workspaceId: string, runId: string) {
  return ["aris", "run", serverId, workspaceId, runId] as const;
}

export function arisIterationsQueryKey(
  serverId: string,
  workspaceId: string,
  runId: string,
  phaseId?: string | null,
) {
  return ["aris", "iterations", serverId, workspaceId, runId, phaseId ?? null] as const;
}

interface UseArisRunsQueryOptions {
  serverId: string;
  workspaceId: string;
}

export function useArisRunsQuery({ serverId, workspaceId }: UseArisRunsQueryOptions) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: arisRunsQueryKey(serverId, workspaceId),
    queryFn: async (): Promise<ArisRunState[]> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const result = await client.listArisRuns(workspaceId);
      return result.runs;
    },
    enabled: !!client && isConnected && !!workspaceId,
    staleTime: 10_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  });

  return {
    runs: query.data ?? [],
    isLoading: !!client && isConnected && !!workspaceId && query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

interface UseArisRunQueryOptions {
  serverId: string;
  workspaceId: string;
  runId: string | null;
}

export function useArisRunQuery({ serverId, workspaceId, runId }: UseArisRunQueryOptions) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: arisRunQueryKey(serverId, workspaceId, runId ?? ""),
    queryFn: async (): Promise<ArisRunState | null> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      if (!runId) {
        return null;
      }
      const result = await client.readArisRun(workspaceId, runId);
      return result.run;
    },
    enabled: !!client && isConnected && !!workspaceId && !!runId,
    staleTime: 10_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  });

  return {
    run: query.data ?? null,
    isLoading: !!client && isConnected && !!workspaceId && !!runId && query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
  };
}

interface UseArisIterationsQueryOptions {
  serverId: string;
  workspaceId: string;
  runId: string | null;
  phaseId?: string | null;
  limit?: number;
}

export function useArisIterationsQuery({
  serverId,
  workspaceId,
  runId,
  phaseId,
  limit,
}: UseArisIterationsQueryOptions) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useQuery({
    queryKey: [...arisIterationsQueryKey(serverId, workspaceId, runId ?? "", phaseId), limit],
    queryFn: async (): Promise<ArisIteration[]> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      if (!runId) {
        return [];
      }
      const result = await client.readArisIterations(workspaceId, runId, {
        phaseId: phaseId ?? undefined,
        limit,
      });
      return result.iterations;
    },
    enabled: !!client && isConnected && !!workspaceId && !!runId,
    staleTime: 10_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
    refetchOnWindowFocus: false,
  });

  return {
    iterations: query.data ?? [],
    isLoading: !!client && isConnected && !!workspaceId && !!runId && query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
  };
}
