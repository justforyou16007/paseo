import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { arisWikiEntityQueryKey } from "./query-keys";

export type ArisWikiEntityType = "papers" | "ideas" | "experiments" | "claims" | "gap";

export interface ArisWikiEntity {
  content: string;
  entityType: ArisWikiEntityType;
  entityId: string;
}

export interface UseArisWikiEntityResult {
  data: ArisWikiEntity | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

export function useArisWikiEntity(
  serverId: string | null,
  cwd: string | null,
  entityType: ArisWikiEntityType | null,
  entityId: string | null,
): UseArisWikiEntityResult {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");

  const query = useQuery({
    queryKey: arisWikiEntityQueryKey(serverId, cwd, entityType, entityId),
    enabled: Boolean(serverId && cwd && entityType && entityId && client && isConnected),
    staleTime: 30_000,
    queryFn: async (): Promise<ArisWikiEntity> => {
      if (!client || !cwd || !entityType || !entityId) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const response = await client.readArisWikiEntity(cwd, entityType, entityId);
      if (response.ok) {
        return {
          content: response.content,
          entityType: response.entityType as ArisWikiEntityType,
          entityId: response.entityId,
        };
      }
      throw new Error(response.error);
    },
  });

  return {
    data: query.data ?? null,
    isLoading:
      Boolean(serverId && cwd && entityType && entityId && client && isConnected) &&
      query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}
