import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  const queryClient = useQueryClient();

  const queryKey = arisWikiQueryKey(serverId, cwd);
  const enabled = Boolean(serverId && cwd && client && isConnected);

  const query = useQuery({
    queryKey,
    enabled,
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

  useEffect(() => {
    if (!enabled || !client || !isConnected || !serverId) {
      return;
    }

    return client.on("aris.wiki.update", (message) => {
      if (message.type !== "aris.wiki.update") {
        return;
      }
      void queryClient.invalidateQueries({ queryKey, type: "active", stale: true });
    });
  }, [client, enabled, isConnected, queryClient, queryKey, serverId]);

  return {
    data: query.data ?? null,
    // When the query is disabled (no cwd yet), report isLoading: false so
    // consumers can render with empty data instead of hanging on a spinner.
    isLoading: enabled && query.isLoading,
    error: query.error,
  };
}
