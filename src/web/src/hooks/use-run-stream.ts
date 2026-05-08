import { useCallback, useEffect, useRef, useState } from "react";
import { abortRun, getRun, getRunEvents, sendControl, streamUrl } from "@/api";
import type { ConnectionStatus, ControlKind, RunRecord, StoredRunEvent } from "@/types";

interface UseRunStreamResult {
  run: RunRecord | undefined;
  events: StoredRunEvent[];
  connection: ConnectionStatus;
  error: string | undefined;
  send: (kind: ControlKind, message: string) => Promise<void>;
  abort: () => Promise<void>;
  refresh: () => Promise<void>;
}

export function useRunStream(
  runId: string | undefined,
  onEventReceived?: () => void,
): UseRunStreamResult {
  const [run, setRun] = useState<RunRecord | undefined>(undefined);
  const [events, setEvents] = useState<StoredRunEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const lastSeqRef = useRef<number>(0);
  const onEventRef = useRef(onEventReceived);

  useEffect(() => {
    onEventRef.current = onEventReceived;
  }, [onEventReceived]);

  const refresh = useCallback(async () => {
    if (!runId) return;
    try {
      const [latest, history] = await Promise.all([getRun(runId), getRunEvents(runId, 0)]);
      setRun(latest);
      setEvents(history);
      lastSeqRef.current = history.at(-1)?.sequence ?? 0;
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [runId]);

  useEffect(() => {
    if (!runId) {
      setRun(undefined);
      setEvents([]);
      setConnection("idle");
      socketRef.current?.close();
      socketRef.current = undefined;
      return;
    }

    let cancelled = false;
    setConnection("connecting");

    void (async () => {
      try {
        const [latest, history] = await Promise.all([getRun(runId), getRunEvents(runId, 0)]);
        if (cancelled) return;
        setRun(latest);
        setEvents(history);
        lastSeqRef.current = history.at(-1)?.sequence ?? 0;
        setError(undefined);

        const socket = new WebSocket(streamUrl(runId, lastSeqRef.current));
        socketRef.current = socket;

        socket.addEventListener("open", () => {
          if (!cancelled) setConnection("online");
        });
        socket.addEventListener("close", () => {
          if (!cancelled) setConnection("offline");
        });
        socket.addEventListener("error", () => {
          if (!cancelled) setConnection("offline");
        });
        socket.addEventListener("message", (msg) => {
          if (cancelled) return;
          try {
            const payload = JSON.parse(msg.data as string) as
              | { type: "event"; event: StoredRunEvent }
              | { type: "error"; error: string };
            if (payload.type === "event") {
              setEvents((prev) => {
                if (payload.event.sequence <= lastSeqRef.current) return prev;
                lastSeqRef.current = payload.event.sequence;
                return [...prev, payload.event];
              });
              if (shouldRefreshRun(payload.event)) {
                void getRun(runId).then((next) => {
                  if (!cancelled) setRun(next);
                });
                onEventRef.current?.();
              }
            } else if (payload.type === "error") {
              setError(payload.error);
            }
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setConnection("offline");
        }
      }
    })();

    return () => {
      cancelled = true;
      socketRef.current?.close();
      socketRef.current = undefined;
    };
  }, [runId]);

  const send = useCallback(
    async (kind: ControlKind, message: string) => {
      if (!runId) return;
      await sendControl(runId, kind, message);
    },
    [runId],
  );

  const abort = useCallback(async () => {
    if (!runId) return;
    await abortRun(runId);
  }, [runId]);

  return { run, events, connection, error, send, abort, refresh };
}

function shouldRefreshRun(event: StoredRunEvent): boolean {
  return event.data.type === "run_status" || event.data.type === "attempt_done" || event.data.type === "verification" || event.data.type === "error";
}
