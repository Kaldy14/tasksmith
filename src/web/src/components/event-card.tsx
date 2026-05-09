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
  delivery: "Delivery",
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
    case "delivery":
      return formatDelivery(data);
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

type DeliveryEvent = Extract<StoredRunEvent["data"], { type: "delivery" }>;

function formatVerification(data: VerificationEvent): string {
  const lines = [`${data.name}: ${data.status}`, `$ ${data.command}`];
  if (data.exitCode !== undefined) lines.push(`exitCode=${data.exitCode}`);
  if (data.durationMs !== undefined) lines.push(`duration=${data.durationMs}ms`);
  if (data.stdout) lines.push(`stdout:\n${data.stdout.trimEnd()}`);
  if (data.stderr) lines.push(`stderr:\n${data.stderr.trimEnd()}`);
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

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function WorkIcon({ type }: { type: string }) {
  if (type === "command" || type === "command_output") return <SquareTerminal className="size-3" />;
  if (type === "tool_call" || type === "tool_result") return <Wrench className="size-3" />;
  if (type === "session_state") return <Bot className="size-3" />;
  return <Zap className="size-3" />;
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
    type === "delivery"
  );
}

function workToneClass(type: string): string {
  if (type === "tool_result") return "text-jade";
  if (type === "verification" || type === "delivery") return "text-jade";
  if (type === "command" || type === "command_output") return "text-copper";
  return "text-muted-foreground/75";
}

export const EventCard = memo(function EventCard({ event }: EventCardProps) {
  const summary = summarize(event);
  const label = TYPE_LABEL[event.type] ?? event.type;

  if (event.type === "user_message") {
    return (
      <article className="flex justify-end py-1.5">
        <div className="max-w-[80%] rounded-2xl rounded-br-md border border-border bg-secondary px-4 py-3">
          <div className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
            {event.data.type === "user_message" ? event.data.text : summary}
          </div>
          <div className="mt-1.5 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground/45">
            <MessageSquare className="size-3" />
            {event.data.type === "user_message" ? CONTROL_TEXT[event.data.control] : label}
            <span>{formatEventTime(event.createdAt)}</span>
          </div>
        </div>
      </article>
    );
  }

  if (event.type === "assistant_delta" || event.type === "assistant_message") {
    return (
      <article className="group py-3">
        <div className="min-w-0 px-1">
          <div className="whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground/95">
            {summary || "(empty response)"}
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground/35">
            <Bot className="size-3" />
            <span>{formatEventTime(event.createdAt)}</span>
          </div>
        </div>
      </article>
    );
  }

  if (isWorkEvent(event.type)) {
    return (
      <article className="py-1.5">
        <div className="rounded-xl border border-border/55 bg-card/45 px-3 py-2.5">
          <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/55">
            <span className={cn("grid size-5 place-items-center rounded-md bg-accent", workToneClass(event.type))}>
              <WorkIcon type={event.type} />
            </span>
            <span>{label}</span>
            <span className="ml-auto font-mono normal-case tracking-normal">
              {event.sequence.toString().padStart(3, "0")}
            </span>
          </div>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-muted-foreground/80">
            {summary}
          </pre>
        </div>
      </article>
    );
  }

  if (event.type === "error") {
    return (
      <article className="py-2">
        <div className="rounded-xl border border-destructive/35 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium">
            <CircleAlert className="size-4" />
            Error
          </div>
          <div className="whitespace-pre-wrap break-words text-xs leading-5">{summary}</div>
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
            "inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/75",
            event.type === "attempt_done" && "text-jade",
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
