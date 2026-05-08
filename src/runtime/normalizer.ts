import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { NormalizedRunEvent } from "../domain/types.js";

type AssistantMessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];

export function normalizePiEvent(event: AgentSessionEvent): NormalizedRunEvent[] {
  switch (event.type) {
    case "agent_start":
      return [{ type: "run_status", status: "running", detail: "Pi agent started" }];
    case "agent_end":
      return [{ type: "run_status", status: "waiting_for_control", detail: `Pi agent finished with ${event.messages.length} new message(s)` }];
    case "message_update":
      return normalizeMessageUpdate(event.assistantMessageEvent);
    case "message_end":
      return normalizeMessageEnd(event.message);
    case "tool_execution_start":
      return normalizeToolStart(event.toolName, event.toolCallId, event.args);
    case "tool_execution_update":
      return normalizeToolUpdate(event.toolName, event.toolCallId, event.partialResult);
    case "tool_execution_end":
      return normalizeToolEnd(event.toolName, event.toolCallId, event.result, event.isError);
    case "queue_update":
      return [{ type: "queue_update", steering: event.steering, followUp: event.followUp }];
    case "auto_retry_start":
      return [{ type: "error", message: "Pi auto-retry started", detail: event.errorMessage }];
    case "auto_retry_end":
      return event.success ? [] : [{ type: "error", message: "Pi auto-retry failed", ...(event.finalError ? { detail: event.finalError } : {}) }];
    case "compaction_end":
      return event.errorMessage ? [{ type: "error", message: "Pi compaction failed", detail: event.errorMessage }] : [];
    case "message_start":
    case "turn_start":
    case "turn_end":
    case "compaction_start":
    case "session_info_changed":
    case "thinking_level_changed":
      return [];
  }
}

function normalizeMessageUpdate(event: AssistantMessageUpdateEvent): NormalizedRunEvent[] {
  switch (event.type) {
    case "text_delta":
      return [{ type: "assistant_delta", text: event.delta }];
    case "toolcall_end":
      return [{ type: "tool_call", name: event.toolCall.name, toolCallId: event.toolCall.id, input: event.toolCall.arguments }];
    case "error":
      return [{ type: "error", message: "Assistant message error", ...(event.error.errorMessage ? { detail: event.error.errorMessage } : {}) }];
    case "start":
    case "text_start":
    case "text_end":
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "done":
      return [];
  }
}

function normalizeMessageEnd(message: AgentMessage): NormalizedRunEvent[] {
  if (isAssistantMessage(message)) {
    return [{ type: "assistant_message", text: assistantText(message), stopReason: message.stopReason }];
  }
  return [];
}

function normalizeToolStart(toolName: string, toolCallId: string, inputValue: unknown): NormalizedRunEvent[] {
  const events: NormalizedRunEvent[] = [{ type: "tool_call", name: toolName, toolCallId, input: inputValue }];
  if (toolName === "bash" && isRecord(inputValue) && typeof inputValue.command === "string") {
    events.push({ type: "command", command: inputValue.command, toolCallId });
  }
  return events;
}

function normalizeToolUpdate(toolName: string, toolCallId: string, partialResult: unknown): NormalizedRunEvent[] {
  const output = toolResultText(partialResult);
  if (!output) return [];
  if (toolName === "bash") return [{ type: "command_output", output, toolCallId }];
  return [{ type: "tool_result", name: toolName, toolCallId, output }];
}

function normalizeToolEnd(toolName: string, toolCallId: string, result: unknown, isError: boolean): NormalizedRunEvent[] {
  const output = toolResultText(result);
  if (toolName === "bash") return [{ type: "command_output", output, toolCallId, isError }];
  return [{ type: "tool_result", name: toolName, toolCallId, output, isError }];
}

export function assistantText(message: AssistantMessage): string {
  return message.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("");
}

function toolResultText(value: unknown): string {
  if (isToolResultMessage(value)) {
    return value.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n");
  }
  if (isRecord(value) && Array.isArray(value.content)) {
    return value.content.flatMap((content) => (isRecord(content) && content.type === "text" && typeof content.text === "string" ? [content.text] : [])).join("\n");
  }
  return stringifyUnknown(value);
}

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return isRecord(message) && message.role === "assistant" && Array.isArray(message.content);
}

function isToolResultMessage(value: unknown): value is ToolResultMessage {
  return isRecord(value) && value.role === "toolResult" && Array.isArray(value.content) && typeof value.toolName === "string";
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function toolCallNames(message: AssistantMessage): string[] {
  return message.content.filter((content): content is ToolCall => content.type === "toolCall").map((toolCall) => toolCall.name);
}
