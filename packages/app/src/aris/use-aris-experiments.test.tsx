/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import React, { type ReactNode } from "react";
import type { ArisExperimentsReadResponse } from "@getpaseo/protocol/messages";
import { useArisExperiments } from "./use-aris-experiments";
import { arisExperimentsQueryKey } from "./query-keys";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const mockClient = {
  readArisExperiments:
    vi.fn<
      (_cwd: string, _experimentId?: string) => Promise<ArisExperimentsReadResponse["payload"]>
    >(),
};

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => mockClient,
  useHostRuntimeIsConnected: () => true,
}));

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("arisExperimentsQueryKey", () => {
  test("includes serverId, cwd and 'all' when experimentId is omitted", () => {
    expect(arisExperimentsQueryKey("server-1", "/workspace")).toEqual([
      "aris",
      "experiments",
      "server-1",
      "/workspace",
      "all",
    ]);
  });

  test("includes the specific experimentId when provided", () => {
    expect(arisExperimentsQueryKey("server-1", "/workspace", "exp-1")).toEqual([
      "aris",
      "experiments",
      "server-1",
      "/workspace",
      "exp-1",
    ]);
  });

  test("falls back to empty strings for null inputs", () => {
    expect(arisExperimentsQueryKey(null, null)).toEqual(["aris", "experiments", "", "", "all"]);
  });
});

describe("useArisExperiments", () => {
  test("returns experiments when the daemon response is ok", async () => {
    const queryClient = createQueryClient();
    const experiments = [
      {
        id: "exp-1",
        metadata: {
          id: "exp-1",
          title: "Scaling run 1",
          content: "Baseline scaling experiment.",
          ideaId: "idea-1",
          status: "completed" as const,
          startedAt: "2026-02-01",
          completedAt: "2026-02-02",
          config: { lr: 0.001 },
        },
        env: { seed: 42 },
        logs: "# Refine log",
        metrics: {
          timestamps: [1, 2, 3],
          series: { loss: [2, 1.5, 1.2] },
        },
      },
    ];
    mockClient.readArisExperiments.mockResolvedValue({
      requestId: "req-1",
      ok: true,
      experiments,
    });

    const { result } = renderHook(() => useArisExperiments("server-1", "/workspace"), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toEqual(experiments);
    expect(result.current.error).toBeNull();
    expect(mockClient.readArisExperiments).toHaveBeenCalledWith("/workspace", undefined);
  });

  test("passes experimentId to the client when provided", async () => {
    const queryClient = createQueryClient();
    mockClient.readArisExperiments.mockResolvedValue({
      requestId: "req-2",
      ok: true,
      experiments: [],
    });

    renderHook(() => useArisExperiments("server-1", "/workspace", "exp-1"), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() =>
      expect(mockClient.readArisExperiments).toHaveBeenCalledWith("/workspace", "exp-1"),
    );
  });

  test("returns an error when the daemon response is not ok", async () => {
    const queryClient = createQueryClient();
    mockClient.readArisExperiments.mockResolvedValue({
      requestId: "req-3",
      ok: false,
      error: "wiki missing",
    });

    const { result } = renderHook(() => useArisExperiments("server-1", "/workspace"), {
      wrapper: createWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("wiki missing");
  });

  test("remains disabled when serverId or cwd is null", () => {
    const queryClient = createQueryClient();
    mockClient.readArisExperiments.mockReset();

    const { result } = renderHook(() => useArisExperiments(null, null), {
      wrapper: createWrapper(queryClient),
    });

    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(mockClient.readArisExperiments).not.toHaveBeenCalled();
  });
});
