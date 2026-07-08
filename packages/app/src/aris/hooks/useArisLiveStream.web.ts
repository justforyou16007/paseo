import { useEffect, useRef, useState, useCallback } from "react";
import type { ArisRunState, ArisLiveDelta } from "@getpaseo/protocol/messages";
import { encodeWorkspaceIdForPathSegment } from "@/utils/host-routes";

export type ArisLiveStreamState =
  | { kind: "disconnected" }
  | { kind: "connecting" }
  | { kind: "connected"; snapshot: ArisRunState[] }
  | { kind: "error"; error: string };

export interface ArisLiveStreamOptions {
  /** HTTP base URL of the daemon, e.g. "http://localhost:6767" */
  daemonHttpUrl: string;
  workspaceId: string;
  runId?: string;
  token?: string;
}

export function useArisLiveStream({
  daemonHttpUrl,
  workspaceId,
  runId,
  token,
}: ArisLiveStreamOptions): {
  state: ArisLiveStreamState;
  deltas: ArisLiveDelta[];
} {
  const [state, setState] = useState<ArisLiveStreamState>({ kind: "disconnected" });
  const [deltas, setDeltas] = useState<ArisLiveDelta[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  const buildUrl = useCallback(() => {
    const encoded = encodeWorkspaceIdForPathSegment(workspaceId);
    const base = daemonHttpUrl.replace(/\/+$/, "");
    const url = new URL(`${base}/api/aris/workspaces/${encoded}/live`);
    if (runId) url.searchParams.set("runId", runId);
    if (token) url.searchParams.set("token", token);
    return url.toString();
  }, [daemonHttpUrl, workspaceId, runId, token]);

  useEffect(() => {
    const url = buildUrl();
    if (!url) return;

    setState({ kind: "connecting" });
    setDeltas([]);

    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.addEventListener("aris.snapshot", (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        setState({ kind: "connected", snapshot: data.runs ?? [] });
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener("aris.delta", (event: MessageEvent) => {
      try {
        const delta = JSON.parse(event.data) as ArisLiveDelta;
        setDeltas((prev) => [...prev, delta]);
      } catch {
        // ignore parse errors
      }
    });

    es.addEventListener("error", () => {
      setState({ kind: "error", error: "SSE connection failed" });
      es.close();
      eventSourceRef.current = null;
    });

    return () => {
      es.close();
      eventSourceRef.current = null;
      setState({ kind: "disconnected" });
    };
  }, [buildUrl]);

  return { state, deltas };
}
