import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowUp, Loader2 } from "lucide-react";
import { createRun, getPublicConfig } from "@/api";
import { HeroCard, HeroShell } from "@/components/hero-shell";
import { RunChipStrip } from "@/components/run-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { SectionLabel } from "@/components/ui/section-label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { RepositorySummary, RunRecord, RuntimeAdapter } from "@/types";

interface HomeHeroProps {
  runs: RunRecord[];
  onCreated: () => void;
}

export function HomeHero({ runs, onCreated }: HomeHeroProps) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [repoKey, setRepoKey] = useState("");
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [adapter, setAdapter] = useState<RuntimeAdapter>("demo");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    void getPublicConfig()
      .then((config) => {
        if (cancelled) return;
        setRepositories(config.repositories);
        setRepoKey((current) => current || config.repositories[0]?.key || "");
      })
      .catch(() => {
        // The API validates run creation. The home surface stays quiet until submit fails.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const recentRuns = useMemo(
    () =>
      [...runs].sort(
        (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
      ),
    [runs],
  );

  const noRepositories = repositories.length === 0;
  const canSubmit = Boolean(repoKey && prompt.trim()) && !submitting && !noRepositories;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const run = await createRun({
        title: title.trim() || deriveTitle(prompt),
        repoKey,
        adapter,
        prompt,
      });
      await navigate({ to: "/runs/$runId", params: { runId: run.id } });
      onCreated();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="min-h-0 flex-1 overflow-auto bg-background">
      <HeroShell
        tagline="Forge tasks into reviewable PRs."
        headline="Start a run."
        footer={
          recentRuns.length > 0 ? (
            <div className="space-y-3">
              <SectionLabel>Recent</SectionLabel>
              <RunChipStrip runs={recentRuns} />
            </div>
          ) : (
            <p className="text-sm text-subtle-foreground">Your runs will land here.</p>
          )
        }
      >
        <form onSubmit={handleSubmit} className="space-y-3">
          <HeroCard>
            <div className="grid gap-3 sm:grid-cols-2">
              <Select value={repoKey} onValueChange={setRepoKey} disabled={submitting || noRepositories}>
                <SelectTrigger aria-label="Repository" className="h-10 bg-surface-1 text-sm">
                  <SelectValue placeholder={noRepositories ? "No repositories configured" : "Repository"} />
                </SelectTrigger>
                <SelectContent>
                  {repositories.length > 0 ? (
                    repositories.map((repo) => (
                      <SelectItem key={repo.key} value={repo.key}>
                        {repo.displayName}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="__none" disabled>
                      No repositories configured
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>

              <Select
                value={adapter}
                onValueChange={(value) => setAdapter(value as RuntimeAdapter)}
                disabled={submitting}
              >
                <SelectTrigger aria-label="Runtime adapter" className="h-10 bg-surface-1 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="demo">demo</SelectItem>
                  <SelectItem value="pi">pi</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Textarea
              id="prompt"
              name="prompt"
              required
              rows={5}
              placeholder="Describe the change. Link a Jira or GitHub issue. Or both."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={submitting}
              className="mt-3 min-h-32 resize-none border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0"
            />

            <div className="mt-3 flex items-center gap-3 border-t border-border pt-3">
              <Input
                id="title"
                name="title"
                maxLength={160}
                placeholder="Title (optional)"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={submitting}
                className="h-10 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
              />
              <Kbd className="hidden sm:inline-flex">⌘↵</Kbd>
              <span title={noRepositories ? "Configure repositories at /config." : undefined}>
                <Button
                  type="submit"
                  size="xl"
                  variant="default"
                  disabled={!canSubmit}
                  className="size-12 rounded-full px-0"
                  aria-label="Start run"
                >
                  {submitting ? (
                    <Loader2 className="size-4 motion-safe:animate-spin" />
                  ) : (
                    <ArrowUp className="size-4" />
                  )}
                </Button>
              </span>
            </div>
          </HeroCard>

          {noRepositories ? (
            <p className="px-1 text-sm text-subtle-foreground">
              Configure repositories in <Link to="/config" className="text-heat hover:underline">Project config</Link> before starting a run.
            </p>
          ) : null}

          {error ? (
            <div
              className="flex items-start gap-2 rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
              aria-live="polite"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
        </form>
      </HeroShell>
    </section>
  );
}

function deriveTitle(prompt: string): string {
  const firstLine = prompt
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "Manual run";
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}
