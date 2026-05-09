import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createRun, getPublicConfig } from "@/api";
import type { RepositorySummary, RuntimeAdapter } from "@/types";

interface IntakeFormProps {
  onCreated?: () => void;
}

export function IntakeForm({ onCreated }: IntakeFormProps) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [repoKey, setRepoKey] = useState("");
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [adapter, setAdapter] = useState<RuntimeAdapter>("demo");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void getPublicConfig()
      .then((config) => {
        if (cancelled) return;
        setRepositories(config.repositories);
        setRepoKey((current) => current || config.repositories[0]?.key || "");
      })
      .catch(() => {
        // Config is advisory for the manual intake UI; run creation still validates server-side.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const run = await createRun({ title, repoKey, adapter, prompt });
      onCreated?.();
      await navigate({ to: "/runs/$runId", params: { runId: run.id } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2.5">
      <Input
        id="title"
        name="title"
        required
        maxLength={160}
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        disabled={submitting}
        className="h-8 text-[0.78rem]"
      />
      <div className="grid grid-cols-2 gap-2">
        {repositories.length > 0 ? (
          <Select value={repoKey} onValueChange={setRepoKey} disabled={submitting}>
            <SelectTrigger id="repoKey" aria-label="Repository" className="h-8 text-[0.78rem]">
              <SelectValue placeholder="Repository" />
            </SelectTrigger>
            <SelectContent>
              {repositories.map((repo) => (
                <SelectItem key={repo.key} value={repo.key}>
                  {repo.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id="repoKey"
            name="repoKey"
            required
            maxLength={80}
            placeholder="Project"
            value={repoKey}
            onChange={(e) => setRepoKey(e.target.value)}
            disabled={submitting}
            className="h-8 text-[0.78rem]"
          />
        )}
        <Select
          value={adapter}
          onValueChange={(v) => setAdapter(v as RuntimeAdapter)}
          disabled={submitting}
        >
          <SelectTrigger id="adapter" aria-label="Runtime adapter" className="h-8 text-[0.78rem]">
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
        rows={4}
        placeholder="Prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={submitting}
        className="text-[0.8rem]"
      />
      {error ? (
        <p className="border border-destructive/40 bg-destructive/10 px-2 py-1.5 font-mono text-[0.72rem] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          variant="heat"
          disabled={submitting || !title || !repoKey || !prompt}
        >
          {submitting ? (
            <>
              <Loader2 className="animate-spin" />
              Starting
            </>
          ) : (
            "Start"
          )}
        </Button>
      </div>
    </form>
  );
}
