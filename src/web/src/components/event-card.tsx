import { memo } from "react";
import {
  Bot,
  Check,
  CircleAlert,
  Clock3,
  MessageSquare,
  SquareTerminal,
  Wrench,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { StoredRunEvent } from "@/types";

const TYPE_LABEL: Record<string, string> = {
  run_status: "Status",
  user_message: "User",
  assistant_delta: "Assistant",
  assistant_message: "Assistant",
  tool_call: "Tool call",
  tool_result: "Tool result",
  command: "Command",
  command_output: "Output",
  queue_update: "Queue",
  session_state: "Session",
  verification: "Verification",
  review: "Review",
  delivery: "Delivery",
  ci: "CI",
  error: "Error",
  attempt_done: "Attempt done",
};

interface EventCardProps {
  event: StoredRunEvent;
}

function summarize(event: StoredRunEvent): string {
  const data = event.data;
  switch (data.type) {
    case "assistant_delta":
      return data.text;
    case "assistant_message":
      return data.text;
    case "run_status":
      return `${data.status}${data.detail ? `: ${data.detail}` : ""}`;
    case "user_message":
      return `${CONTROL_TEXT[data.control]} (${data.delivery})\n${data.text}${data.error ? `\n${data.error}` : ""}`;
    case "tool_call":
      return `${data.name} ${JSON.stringify(data.input ?? {})}`;
    case "tool_result":
      return `${data.name}\n${data.output}`;
    case "command":
      return data.command;
    case "command_output":
      return data.output;
    case "queue_update":
      return `steer=${data.steering.length} · follow_up=${data.followUp.length}`;
    case "session_state":
      return `session=${data.sessionId} · messages=${data.messageCount} · streaming=${data.isStreaming}`;
    case "verification":
      return formatVerification(data);
    case "review":
      return formatReview(data);
    case "delivery":
      return formatDelivery(data);
    case "ci":
      return formatCi(data);
    case "error":
      return `${data.message}${data.detail ? `\n${data.detail}` : ""}`;
    case "attempt_done":
      return `${data.status}${data.summary ? `\n${data.summary}` : ""}`;
    default:
      return JSON.stringify(data, null, 2);
  }
}

const CONTROL_TEXT = {
  steer: "steer",
  follow_up: "follow-up",
  prompt: "prompt",
} as const;

type VerificationEvent = Extract<StoredRunEvent["data"], { type: "verification" }>;

type ReviewEvent = Extract<StoredRunEvent["data"], { type: "review" }>;

type DeliveryEvent = Extract<StoredRunEvent["data"], { type: "delivery" }>;

type CiEvent = Extract<StoredRunEvent["data"], { type: "ci" }>;

function formatVerification(data: VerificationEvent): string {
  const lines = [`${data.name}: ${data.status}`, `$ ${data.command}`];
  if (data.exitCode !== undefined) lines.push(`exitCode=${data.exitCode}`);
  if (data.durationMs !== undefined) lines.push(`duration=${data.durationMs}ms`);
  if (data.stdout) lines.push(`stdout:\n${data.stdout.trimEnd()}`);
  if (data.stderr) lines.push(`stderr:\n${data.stderr.trimEnd()}`);
  if (data.error) lines.push(`error=${data.error}`);
  return lines.join("\n");
}

function formatReview(data: ReviewEvent): string {
  const lines = [`review: ${data.status}`];
  if (data.summary) lines.push(data.summary);
  if (data.diffStat) lines.push(`diff stat:\n${data.diffStat}`);
  if (data.findings && data.findings.length > 0) {
    lines.push("findings:");
    for (const finding of data.findings) {
      lines.push(`- [${finding.severity}] ${finding.title}${finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : ""}`);
      lines.push(`  ${finding.description}`);
      if (finding.suggestedFix) lines.push(`  fix: ${finding.suggestedFix}`);
    }
  }
  if (data.error) lines.push(`error=${data.error}`);
  return lines.join("\n");
}

function formatDelivery(data: DeliveryEvent): string {
  const lines = [`${data.mode}: ${data.status}`];
  if (data.provider) lines.push(`provider=${data.provider}`);
  if (data.branch) lines.push(`branch=${data.branch}`);
  if (data.url) lines.push(`url=${data.url}`);
  if (data.number !== undefined) lines.push(`number=${data.number}`);
  if (data.detail) lines.push(data.detail);
  if (data.error) lines.push(`error=${data.error}`);
  return lines.join("\n");
}

function formatCi(data: CiEvent): string {
  const lines = [`${data.provider}: ${data.status}`, data.summary];
  if (data.attempt !== undefined) lines.push(`poll=${data.attempt}`);
  if (data.detailsUrl) lines.push(`details=${data.detailsUrl}`);
  if (data.log) lines.push(`failed log:\n${data.log}`);
  return lines.join("\n");
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatStatusLabel(status: string): string {
  switch (status) {
    case "waiting_for_control":
      return "Waiting for control";
    case "watching_ci":
      return "Watching CI";
    case "creating_pr":
      return "Creating PR";
    case "pr_created":
      return "PR created";
    default:
      return status.replace(/_/gu, " ").replace(/^./u, (char) => char.toUpperCase());
  }
}

function statusToneClass(status: string): string {
  if (status === "waiting_for_control") return "border-heat/35 bg-heat-muted text-heat";
  if (status === "completed" || status === "pr_created") return "border-jade/35 bg-jade/10 text-jade";
  if (status === "failed" || status === "cancelled") return "border-destructive/35 bg-destructive/10 text-destructive";
  if (status === "queued") return "border-border bg-accent text-muted-foreground";
  return "border-copper/35 bg-copper/10 text-copper";
}

function WorkIcon({ type }: { type: string }) {
  if (type === "command" || type === "command_output") return <SquareTerminal className="size-3.5" />;
  if (type === "tool_call" || type === "tool_result") return <Wrench className="size-3.5" />;
  if (type === "session_state") return <Bot className="size-3.5" />;
  return <Zap className="size-3.5" />;
}

function isWorkEvent(type: string): boolean {
  return (
    type === "tool_call" ||
    type === "tool_result" ||
    type === "command" ||
    type === "command_output" ||
    type === "queue_update" ||
    type === "session_state" ||
    type === "verification" ||
    type === "review" ||
    type === "delivery" ||
    type === "ci"
  );
}

function workChipClass(type: string): string {
  if (type === "tool_result") return "bg-jade/12 text-jade";
  if (type === "verification" || type === "review" || type === "delivery" || type === "ci")
    return "bg-jade/12 text-jade";
  if (type === "command" || type === "command_output") return "bg-copper/12 text-copper";
  if (type === "tool_call") return "bg-steel/12 text-steel";
  return "bg-accent text-muted-foreground";
}

export const EventCard = memo(function EventCard({ event }: EventCardProps) {
  const summary = summarize(event);
  const label = TYPE_LABEL[event.type] ?? event.type;

  if (event.type === "user_message") {
    return (
      <article className="flex justify-end py-2">
        <div className="max-w-[78%] rounded-2xl rounded-br-md border border-heat/25 bg-heat-muted px-4 py-3">
          <div className="whitespace-pre-wrap break-words text-base leading-6 text-foreground">
            {event.data.type === "user_message" ? event.data.text : summary}
          </div>
          <div className="mt-2 flex items-center justify-end gap-1.5 text-mono-xs text-subtle-foreground">
            <MessageSquare className="size-3" />
            <span className="uppercase tracking-caption">
              {event.data.type === "user_message" ? CONTROL_TEXT[event.data.control] : label}
            </span>
            <span>{formatEventTime(event.createdAt)}</span>
          </div>
        </div>
      </article>
    );
  }

  if (event.type === "assistant_delta" || event.type === "assistant_message") {
    return (
      <article className="group py-3.5">
        <div className="min-w-0 px-1">
          <div className="whitespace-pre-wrap break-words text-base leading-7 text-foreground">
            {summary || "(empty response)"}
          </div>
          <div className="mt-2 flex items-center gap-2 text-mono-xs text-subtle-foreground">
            <Bot className="size-3" />
            <span>{formatEventTime(event.createdAt)}</span>
          </div>
        </div>
      </article>
    );
  }

  if (event.type === "run_status" && event.data.type === "run_status") {
    return (
      <article className="py-2.5">
        <div className="my-1 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <div className="flex max-w-[78ch] flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-lg border border-border bg-surface-1/80 px-3 py-1.5 text-sm leading-5 text-muted-foreground">
            <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-caption tracking-caption", statusToneClass(event.data.status))}>
              <Clock3 className="size-3" />
              {formatStatusLabel(event.data.status)}
            </span>
            {event.data.detail ? <span className="normal-case tracking-normal">{event.data.detail}</span> : null}
          </div>
          <span className="h-px flex-1 bg-border" />
        </div>
      </article>
    );
  }

  if (event.type === "attempt_done" && event.data.type === "attempt_done") {
    const completed = event.data.status === "completed";
    const failed = event.data.status === "failed" || event.data.status === "aborted";
    return (
      <article className="py-3">
        <div className="mx-auto flex max-w-[78ch] items-start gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3">
          <span
            className={cn(
              "mt-0.5 grid size-6 shrink-0 place-items-center rounded-md",
              completed && "bg-jade/12 text-jade",
              failed && "bg-destructive/12 text-destructive",
              !completed && !failed && "bg-accent text-muted-foreground",
            )}
          >
            {completed ? <Check className="size-3.5" /> : <Clock3 className="size-3.5" />}
          </span>
          <div className="min-w-0 space-y-1">
            <div className={cn("text-caption font-medium tracking-caption", completed && "text-jade", failed && "text-destructive", !completed && !failed && "text-muted-foreground")}>
              Attempt {formatStatusLabel(event.data.status).toLowerCase()}
            </div>
            {event.data.summary ? (
              <div className="whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">{event.data.summary}</div>
            ) : null}
          </div>
        </div>
      </article>
    );
  }

  if (isWorkEvent(event.type)) {
    return (
      <article className="py-1.5">
        <div className="rounded-lg border border-border bg-surface-1 px-3.5 py-3">
          <div className="mb-2 flex items-center gap-2 text-caption uppercase tracking-caption text-subtle-foreground">
            <span className={cn("grid size-5 place-items-center rounded-md", workChipClass(event.type))}>
              <WorkIcon type={event.type} />
            </span>
            <span className="text-muted-foreground">{label}</span>
            <span className="ml-auto font-mono text-mono-xs normal-case tracking-normal text-subtle-foreground">
              {event.sequence.toString().padStart(3, "0")}
            </span>
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-sm leading-5 text-muted-foreground">
            {summary}
          </pre>
        </div>
      </article>
    );
  }

  if (event.type === "error") {
    return (
      <article className="py-2">
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-3 text-destructive">
          <div className="mb-1.5 flex items-center gap-2 text-caption font-medium uppercase tracking-caption">
            <CircleAlert className="size-3.5" />
            Error
          </div>
          <div className="whitespace-pre-wrap break-words font-mono text-sm leading-5">{summary}</div>
        </div>
      </article>
    );
  }

  return (
    <article className="py-2">
      <div className="my-1 flex items-center gap-3">
        <span className="h-px flex-1 bg-border" />
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-1 px-2.5 py-1 text-mono-xs uppercase tracking-caption text-subtle-foreground",
            event.type === "attempt_done" && "border-jade/35 text-jade",
          )}
        >
          {event.type === "attempt_done" ? <Check className="size-3" /> : <Clock3 className="size-3" />}
          {summary}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
    </article>
  );
});
