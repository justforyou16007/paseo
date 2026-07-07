import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { arisWikiQueryKey } from "./query-keys";
import type { ArisWikiData } from "./types";

export interface UseArisWikiResult {
  data: ArisWikiData | null;
  isLoading: boolean;
  error: Error | null;
}

export function useArisWiki(serverId: string | null, cwd: string | null): UseArisWikiResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");

  const query = useQuery({
    queryKey: arisWikiQueryKey(serverId, cwd),
    enabled: Boolean(serverId && cwd && client && isConnected),
    staleTime: 30_000,
    queryFn: async () => {
      if (!client || !cwd) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const response = await client.readArisWiki(cwd);
      if (response.ok) {
        return response;
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
