import { useCallback, useEffect, useRef, useState } from "react";
import { listRuns } from "@/api";
import type { RunRecord } from "@/types";

export function useRuns(options: { enabled?: boolean } = {}): {
  runs: RunRecord[];
  loading: boolean;
  error: string | undefined;
  refresh: () => Promise<void>;
} {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const enabled = options.enabled ?? true;
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | undefined>(undefined);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await listRuns();
      setRuns(next);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { runs, loading, error, refresh };
}
