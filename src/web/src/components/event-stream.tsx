import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EventCard } from "./event-card";
import type { StoredRunEvent } from "@/types";

interface EventStreamProps {
  events: StoredRunEvent[];
  emptyHint?: string;
}

export function EventStream({ events, emptyHint }: EventStreamProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const displayEvents = compactAssistantDeltas(events);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length]);

  return (
    <ScrollArea className="h-full">
      <div className="flex min-h-full flex-col pb-8 pt-6">
        {events.length === 0 ? (
          <div className="flex flex-1 items-center justify-center py-20">
            <p className="text-base text-subtle-foreground">{emptyHint ?? "No events yet."}</p>
          </div>
        ) : (
          <div className="space-y-1">
            {displayEvents.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

function compactAssistantDeltas(events: readonly StoredRunEvent[]): StoredRunEvent[] {
  const compacted: StoredRunEvent[] = [];
  let pending: StoredRunEvent | undefined;

  for (const event of events) {
    if (event.data.type === "assistant_delta") {
      if (!pending) {
        pending = { ...event, data: { ...event.data } };
      } else if (pending.data.type === "assistant_delta") {
        pending = {
          ...pending,
          id: `${pending.id}-${event.sequence}`,
          sequence: event.sequence,
          createdAt: event.createdAt,
          data: { type: "assistant_delta", text: `${pending.data.text}${event.data.text}` },
        };
      }
      continue;
    }

    if (pending) {
      compacted.push(pending);
      pending = undefined;
    }
    compacted.push(event);
  }

  if (pending) compacted.push(pending);
  return compacted;
}
