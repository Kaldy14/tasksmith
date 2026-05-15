import type { SourceCommentSnapshot } from "../domain/types.js";

const TASKSMITH_MENTION = /@tasksmith\b/iu;

export function extractTaskSmithCommand(text: string): string | undefined {
  const match = TASKSMITH_MENTION.exec(text);
  if (!match) return undefined;
  const afterMention = text.slice(match.index + match[0].length).trim();
  return afterMention.length > 0 ? afterMention : "Please handle this issue.";
}

export function extractTaskSmithCommands(comments: readonly SourceCommentSnapshot[]): string[] {
  return comments.flatMap((comment) => {
    const command = extractTaskSmithCommand(comment.body);
    return command ? [`[comment ${comment.id}] ${command}`] : [];
  });
}
