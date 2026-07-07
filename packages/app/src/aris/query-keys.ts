export function arisWikiQueryKey(serverId: string | null, cwd: string | null) {
  return ["aris", "wiki", serverId ?? "", cwd ?? ""] as const;
}

export function arisExperimentsQueryKey(
  serverId: string | null,
  cwd: string | null,
  experimentId?: string | null,
) {
  return ["aris", "experiments", serverId ?? "", cwd ?? "", experimentId ?? "all"] as const;
}
