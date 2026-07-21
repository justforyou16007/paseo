export function arisWikiQueryKey(serverId: string | null, cwd: string | null) {
  return ["aris", "wiki", serverId ?? "", cwd ?? ""] as const;
}

export function arisWikiEntityQueryKey(
  serverId: string | null,
  cwd: string | null,
  entityType: string | null,
  entityId: string | null,
) {
  return [
    "aris",
    "wiki-entity",
    serverId ?? "",
    cwd ?? "",
    entityType ?? "",
    entityId ?? "",
  ] as const;
}

export function arisExperimentsQueryKey(
  serverId: string | null,
  cwd: string | null,
  experimentId?: string | null,
) {
  return ["aris", "experiments", serverId ?? "", cwd ?? "", experimentId ?? "all"] as const;
}
