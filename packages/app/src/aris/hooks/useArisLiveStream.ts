/**
 * SSE live stream hook is only available on web.
 * On native, this is a no-op placeholder.
 */
export interface ArisLiveStreamState {
  kind: "unavailable";
}

export function useArisLiveStream(): { state: ArisLiveStreamState; deltas: never[] } {
  return { state: { kind: "unavailable" }, deltas: [] };
}
