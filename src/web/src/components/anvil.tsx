import { useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Folder, GitPullRequest, Link2, Power, RefreshCw, RotateCcw } from "lucide-react";
import { ControlBar } from "@/components/control-bar";
import { EventStream } from "@/components/event-stream";
import { StatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { PageHeader, PageTitle } from "@/components/ui/page-header";
import { createRun } from "@/api";
import { useRunStream } from "@/hooks/use-run-stream";
import { formatRelativeTime, shortId } from "@/lib/utils";
import type { ConnectionStatus, RunRecord, RunStatus, RunSourceType, TerminalFollowUpMode } from "@/types";

interface AnvilProps {
  runId: string;
  onConnectionChange?: (status: ConnectionStatus) => void;
  onActivity?: () => void;
}

const CONTROLLABLE: RunStatus[] = ["preparing", "running", "waiting_for_control", "fixing"];
const TERMINAL: RunStatus[] = ["completed", "pr_created", "failed", "cancelled"];

export function Anvil({ runId, onConnectionChange, onActivity }: AnvilProps) {
  const navigate = useNavigate();
  const { run, events, connection, error, send, reopen, abort, refresh } = useRunStream(runId, onActivity);

  useEffect(() => {
    onConnectionChange?.(connection);
  }, [connection, onConnectionChange]);

  const controlsActive = run ? CONTROLLABLE.includes(run.status) : false;
  const canReopen = run ? TERMINAL.includes(run.status) : false;
  const composerEnabled = controlsActive || canReopen;

  async function handleTerminalFollowUp(mode: TerminalFollowUpMode, message: string): Promise<void> {
    if (!run) return;
    if (mode === "same_run") {
      await reopen(message);
      onActivity?.();
      return;
    }
    const linkedRun = await createRun({
      title: `Follow-up: ${run.title}`,
      repoKey: run.repoKey,
      adapter: run.adapter,
      prompt: buildLinkedRunPrompt(run, message),
    });
    onActivity?.();
    await navigate({ to: "/runs/$runId", params: { runId: linkedRun.id } });
  }

  function focusComposer(): void {
    document.getElementById("run-control-message")?.focus();
  }

  return (
    <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <PageHeader
        primary={
          <>
            {run ? (
              <PageTitle title={run.title} />
            ) : (
              <div className="min-w-0 flex-1" aria-label="Loading run">
                <div className="h-6 w-64 max-w-full rounded-md bg-accent motion-safe:animate-pulse" />
              </div>
            )}
            {run ? <StatusPill status={run.status} className="shrink-0" /> : null}
            {canReopen ? (
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="shrink-0"
                onClick={focusComposer}
              >
                <RotateCcw className="size-3.5" />
                Reopen
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              type="button"
              className="size-8 shrink-0"
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
              className="size-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={() => void abort()}
              disabled={!controlsActive}
              aria-label="Abort run"
            >
              <Power className="size-3.5" />
            </Button>
          </>
        }
        secondary={
          run ? (
            <>
              <Chip tone="muted" icon={<Folder />}>
                {repoLabel(run.repoKey)}
              </Chip>
              {run.source ? (
                run.source.url ? (
                  <Chip tone="muted" icon={<Link2 />} href={run.source.url} external>
                    {sourceLabel(run.sourceType, run.source.key)}
                  </Chip>
                ) : (
                  <Chip tone="muted" icon={<Link2 />}>
                    {sourceLabel(run.sourceType, run.source.key)}
                  </Chip>
                )
              ) : null}
              {run.pullRequest ? (
                <Chip tone="jade" icon={<GitPullRequest />} href={run.pullRequest.url} external>
                  PR {run.pullRequest.number ? `#${run.pullRequest.number}` : run.pullRequest.branch}
                </Chip>
              ) : null}
              <span className="ml-auto font-mono text-sm text-subtle-foreground">
                {shortId(run.id)} · {formatRelativeTime(run.updatedAt)}
              </span>
            </>
          ) : undefined
        }
      />

      {run?.error ? (
        <div className="border-b border-destructive/25 bg-destructive/10 px-6 py-2.5 text-sm text-destructive">
          {run.error}
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto h-full w-full max-w-[1024px] px-6">
          <EventStream events={events} emptyHint="No events yet." />
        </div>
      </div>

      {error ? (
        <div className="border-t border-destructive/25 bg-destructive/10 px-6 py-2.5 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="shrink-0 px-6 pb-4 pt-2">
        <div className="mx-auto w-full max-w-[1024px]">
          <ControlBar
            adapter={run?.adapter}
            disabled={!composerEnabled}
            terminal={canReopen}
            onSend={send}
            onTerminalSubmit={handleTerminalFollowUp}
          />
        </div>
      </div>
    </section>
  );
}

function sourceLabel(sourceType: RunSourceType, key: string): string {
  if (sourceType === "github_issue") return `GitHub ${key}`;
  if (sourceType === "jira") return `Jira ${key}`;
  return key;
}

function buildLinkedRunPrompt(run: RunRecord, message: string): string {
  return [
    `This is a new TaskSmith run created as a follow-up to run ${run.id}.`,
    `Previous title: ${run.title}`,
    `Previous status: ${run.status}`,
    `Repository: ${run.repoKey}`,
    run.pullRequest ? `Previous pull request: ${run.pullRequest.url}` : "Previous pull request: none recorded",
    run.source?.url ? `Previous source: ${run.source.url}` : undefined,
    "",
    "Use the previous run as context, but treat this as a fresh chat and fresh workspace.",
    "Do not assume uncommitted files from the previous workspace are present unless you inspect or fetch them through the linked PR/source.",
    "Make the smallest correct change, then stop. TaskSmith will handle verification, review, and delivery.",
    "",
    "Operator follow-up request:",
    message,
  ].filter((line): line is string => line !== undefined).join("\n");
}

function repoLabel(repoKey: string): string {
  if (repoKey.toLowerCase() === "tasksmith") return "TaskSmith";
  return repoKey
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
