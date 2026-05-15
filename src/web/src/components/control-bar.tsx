import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, Bot, MessageSquare, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ControlKind, RuntimeAdapter, TerminalFollowUpMode } from "@/types";

interface ControlBarProps {
  adapter?: RuntimeAdapter;
  disabled?: boolean;
  terminal?: boolean;
  onSend: (kind: ControlKind, message: string) => Promise<void>;
  onTerminalSubmit?: (mode: TerminalFollowUpMode, message: string) => Promise<void>;
}

const CONTROL_LABEL: Record<ControlKind, string> = {
  steer: "Steer",
  follow_up: "Follow-up",
  prompt: "Prompt",
};

const TERMINAL_LABEL: Record<TerminalFollowUpMode, string> = {
  same_run: "Continue run",
  new_run: "New chat",
};

export function ControlBar({ adapter, disabled, terminal = false, onSend, onTerminalSubmit }: ControlBarProps) {
  const [kind, setKind] = useState<ControlKind>("steer");
  const [terminalMode, setTerminalMode] = useState<TerminalFollowUpMode>("same_run");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      if (terminal) {
        if (!onTerminalSubmit) return;
        await onTerminalSubmit(terminalMode, trimmed);
      } else {
        await onSend(kind, trimmed);
      }
      setMessage("");
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      formRef.current?.requestSubmit();
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      className={cn(
        "group rounded-2xl border border-border bg-surface-1 p-px transition-all duration-200",
        "focus-within:border-heat/55 focus-within:shadow-[0_0_0_4px_var(--heat-muted)]",
        disabled && "opacity-70",
      )}
    >
      <div className="rounded-[15px] bg-surface-2">
        <textarea
          id="run-control-message"
          name="message"
          autoComplete="off"
          required
          rows={3}
          disabled={disabled || busy}
          placeholder={terminal ? "Describe the follow-up. Continue this run or start a linked chat." : "Steer the agent, ask a follow-up, or paste a new prompt"}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={onKeyDown}
          className={cn(
            "block max-h-48 min-h-24 w-full resize-none border-0 bg-transparent px-4 pb-2 pt-4 text-base leading-6 text-foreground",
            "placeholder:text-subtle-foreground outline-none focus:ring-0",
            "disabled:cursor-not-allowed",
          )}
        />
        <div className="flex min-w-0 items-center gap-2 px-3 pb-3">
          {terminal ? (
            <Select
              value={terminalMode}
              onValueChange={(v) => setTerminalMode(v as TerminalFollowUpMode)}
              disabled={disabled}
            >
              <SelectTrigger
                aria-label="Follow-up mode"
                className="h-8 w-auto shrink-0 gap-2 border-0 bg-transparent px-2 text-caption font-medium uppercase tracking-caption shadow-none hover:bg-accent focus:border-0 focus:ring-0"
              >
                <MessageSquare className="size-3.5 text-muted-foreground" />
                <SelectValue>{TERMINAL_LABEL[terminalMode]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="same_run">Continue run</SelectItem>
                <SelectItem value="new_run">New chat</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Select value={kind} onValueChange={(v) => setKind(v as ControlKind)} disabled={disabled}>
              <SelectTrigger
                aria-label="Control kind"
                className="h-8 w-auto shrink-0 gap-2 border-0 bg-transparent px-2 text-caption font-medium uppercase tracking-caption shadow-none hover:bg-accent focus:border-0 focus:ring-0"
              >
                <MessageSquare className="size-3.5 text-muted-foreground" />
                <SelectValue>{CONTROL_LABEL[kind]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="steer">Steer</SelectItem>
                <SelectItem value="follow_up">Follow-up</SelectItem>
                <SelectItem value="prompt">Prompt</SelectItem>
              </SelectContent>
            </Select>
          )}

          <span className="hidden h-4 w-px bg-border sm:block" />
          <span className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-caption text-subtle-foreground sm:inline-flex">
            <Bot className="size-3.5" />
            {adapter === "pi" ? "Pi runtime" : "Demo runtime"}
          </span>
          <span className="hidden h-4 w-px bg-border md:block" />
          <span className="hidden items-center gap-1.5 rounded-md px-2 py-1 text-caption text-subtle-foreground md:inline-flex">
            <ShieldCheck className="size-3.5" />
            Sandboxed
          </span>

          <span className="ml-auto hidden font-mono text-mono-xs tracking-tight text-subtle-foreground sm:inline">
            ⌘↵
          </span>
          <Button
            type="submit"
            variant="heat"
            size="icon"
            disabled={disabled || busy || !message.trim()}
            className="size-9 rounded-full"
            aria-label={terminal ? "Send follow-up" : "Send message"}
          >
            <ArrowUp className="size-4" />
          </Button>
        </div>
      </div>
    </form>
  );
}
