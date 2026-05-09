import { useEffect } from "react";
import { ExternalLink, Folder, PanelRight, Power, RefreshCw, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ControlBar } from "./control-bar";
import { EventStream } from "./event-stream";
import { StatusPill } from "./status-pill";
import { useRunStream } from "@/hooks/use-run-stream";
import { formatRelativeTime, shortId } from "@/lib/utils";
import type { ConnectionStatus } from "@/types";

interface AnvilProps {
  runId: string | undefined;
  onConnectionChange?: (status: ConnectionStatus) => void;
  onActivity?: () => void;
}

export function Anvil({ runId, onConnectionChange, onActivity }: AnvilProps) {
  const { run, events, connection, error, send, abort, refresh } = useRunStream(runId, onActivity);

  useEffect(() => {
    onConnectionChange?.(connection);
  }, [connection, onConnectionChange]);

  if (!runId) {
    return <EmptyAnvil />;
  }

  const controlsActive =
    run?.status === "running" ||
    run?.status === "preparing" ||
    run?.status === "waiting_for_control";

  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-background px-4 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          {run ? (
            <>
              <h2 className="min-w-0 truncate text-sm font-semibold tracking-tight text-foreground">
                {run.title}
              </h2>
              <span className="hidden rounded-md border border-border bg-accent px-2 py-0.5 text-[11px] font-medium text-muted-foreground sm:inline-flex">
                {run.repoKey}
              </span>
              {run.source ? (
                run.source.url ? (
                  <a
                    href={run.source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="hidden max-w-[190px] items-center gap-1 truncate rounded-md border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground md:inline-flex"
                  >
                    <span className="truncate">{sourceLabel(run.sourceType, run.source.key)}</span>
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                ) : (
                  <span className="hidden max-w-[190px] truncate rounded-md border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground md:inline-flex">
                    {sourceLabel(run.sourceType, run.source.key)}
                  </span>
                )
              ) : null}
              {run.pullRequest ? (
                <a
                  href={run.pullRequest.url}
                  target="_blank"
                  rel="noreferrer"
                  className="hidden max-w-[150px] items-center gap-1 truncate rounded-md border border-jade/30 bg-jade/10 px-2 py-0.5 text-[11px] font-medium text-jade hover:text-jade md:inline-flex"
                >
                  <span className="truncate">PR {run.pullRequest.number ? `#${run.pullRequest.number}` : run.pullRequest.branch}</span>
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              ) : null}
              <StatusPill status={run.status} className="hidden lg:inline-flex" />
              <span className="hidden text-[11px] text-muted-foreground/55 xl:inline">
                {shortId(run.id)} · {formatRelativeTime(run.updatedAt)}
              </span>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Loading...</p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className="size-8"
            onClick={() => void refresh()}
            disabled={!run}
            aria-label="Refresh run"
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className="size-8 text-muted-foreground hover:text-destructive"
            onClick={() => void abort()}
            disabled={!controlsActive}
            aria-label="Abort run"
          >
            <Power className="size-3.5" />
          </Button>
        </div>
      </header>

      {run?.error ? (
        <div className="border-b border-destructive/25 bg-destructive/10 px-5 py-2 text-xs text-destructive">
          {run.error}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto h-full w-full max-w-[960px] px-4 sm:px-6">
          <EventStream events={events} emptyHint="No events yet." />
        </div>
      </div>

      {error ? (
        <div className="border-t border-destructive/25 bg-destructive/10 px-5 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="shrink-0 px-4 pb-3 pt-2 sm:px-6">
        <div className="mx-auto w-full max-w-[960px]">
          <ControlBar adapter={run?.adapter} disabled={!controlsActive} onSend={send} />
          <div className="mt-2 flex items-center justify-between px-1 text-[11px] text-muted-foreground/55">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Folder className="size-3.5" />
              Local checkout
            </span>
            <span className="inline-flex items-center gap-1.5">
              <SquareTerminal className="size-3.5" />
              {events.length.toString().padStart(3, "0")} events
              <PanelRight className="ml-2 size-3.5" />
              {connection}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

function sourceLabel(sourceType: string, key: string): string {
  if (sourceType === "github_issue") return `GitHub ${key}`;
  if (sourceType === "jira") return `Jira ${key}`;
  return key;
}

function EmptyAnvil() {
  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center border-b border-border px-5">
        <p className="text-sm font-medium text-muted-foreground">Select a thread</p>
      </header>
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 grid size-10 place-items-center rounded-2xl border border-border bg-card text-muted-foreground">
            <SquareTerminal className="size-5" />
          </div>
          <h1 className="text-sm font-semibold text-foreground">No thread selected</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Pick a run from the sidebar or start a new one from Projects.
          </p>
        </div>
      </div>
    </section>
  );
}
