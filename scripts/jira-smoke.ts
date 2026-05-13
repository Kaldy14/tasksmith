#!/usr/bin/env tsx

import { getJiraIssueContext, loadJiraClientConfig, searchJiraIssueContexts } from "../src/sources/jira-client.js";

async function main(): Promise<void> {
  const issueKey = process.argv[2] ?? process.env.TASKSMITH_JIRA_SMOKE_ISSUE;
  if (!issueKey?.trim()) throw new Error("Usage: pnpm jira:smoke <ISSUE-KEY>");

  const normalizedIssueKey = issueKey.trim().toUpperCase();
  const client = loadJiraClientConfig();
  const issue = await getJiraIssueContext(client, normalizedIssueKey);
  const searchMatches = await searchJiraIssueContexts(client, `key = ${normalizedIssueKey}`);

  console.log(JSON.stringify({
    ok: true,
    issueKey: normalizedIssueKey,
    readOnly: true,
    searchEndpoint: "/rest/api/3/search/jql",
    searchMatched: searchMatches.some((candidate) => candidate.key === normalizedIssueKey),
    issueReadable: issue.key === normalizedIssueKey,
    hasDescription: issue.description.length > 0,
    labelsCount: issue.labels.length,
    commentsCount: issue.comments.length,
    attachmentsCount: issue.attachments.length,
    statusReadable: Boolean(issue.metadata.status),
    projectReadable: Boolean(issue.metadata.projectKey),
    issueTypeReadable: Boolean(issue.metadata.issueType),
    componentCount: issue.metadata.components?.length ?? 0,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
