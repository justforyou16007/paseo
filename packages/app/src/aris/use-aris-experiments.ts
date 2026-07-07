import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { arisExperimentsQueryKey } from "./query-keys";
import type { ArisExperimentRun } from "./types";

export interface UseArisExperimentsResult {
  data: ArisExperimentRun[] | null;
  isLoading: boolean;
  error: Error | null;
}

export function useArisExperiments(
  serverId: string | null,
  cwd: string | null,
  experimentId?: string | null,
): UseArisExperimentsResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");

  const query = useQuery({
    queryKey: arisExperimentsQueryKey(serverId, cwd, experimentId),
    enabled: Boolean(serverId && cwd && client && isConnected),
    staleTime: 30_000,
    queryFn: async () => {
      if (!client || !cwd) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const response = await client.readArisExperiments(
        cwd,
        experimentId ? experimentId : undefined,
      );
      if (response.ok) {
        return response.experiments;
      }
      throw new Error(response.error);
    },
  });

  return {
    data: query.data ?? null,
    isLoading: query.isLoading,
    error: query.error,
  };
}
