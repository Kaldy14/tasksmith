import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, Save } from "lucide-react";
import { getEditableConfig, saveEditableConfig } from "@/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, PageTitle } from "@/components/ui/page-header";
import { Textarea } from "@/components/ui/textarea";
import type { EditableConfigResponse } from "@/types";

const CARD_CLASS = "border-border-strong bg-surface-2 shadow-none backdrop-blur-none";

export function ConfigPage() {
  const [response, setResponse] = useState<EditableConfigResponse | undefined>();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [saved, setSaved] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getEditableConfig()
      .then((config) => {
        if (cancelled) return;
        setResponse(config);
        setText(JSON.stringify(config.config, null, 2));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(text) as unknown };
    } catch (err: unknown) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  }, [text]);

  async function save(): Promise<void> {
    setError(undefined);
    setSaved(undefined);
    if (!parsed.ok) {
      setError(`Invalid JSON: ${parsed.error}`);
      return;
    }
    setSaving(true);
    try {
      const next = await saveEditableConfig(parsed.value);
      setResponse(next);
      setText(JSON.stringify(next.config, null, 2));
      setSaved("Configuration saved. New runs will use the updated project setup.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function formatJson(): void {
    if (!parsed.ok) {
      setError(`Invalid JSON: ${parsed.error}`);
      return;
    }
    setError(undefined);
    setText(JSON.stringify(parsed.value, null, 2));
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <PageHeader
        primary={
          <>
            <PageTitle
              title="Project configuration"
              subtitle={response?.path ?? "No TASKSMITH_CONFIG_PATH configured"}
            />
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={formatJson}
                disabled={loading || saving || !text}
              >
                Format JSON
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={() => void save()}
                disabled={loading || saving || !response?.writable || !parsed.ok}
              >
                {saving ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <Save className="size-3.5" />}
                Save
              </Button>
            </div>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <div className="mx-auto grid w-full max-w-6xl gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card className={`min-w-0 ${CARD_CLASS}`}>
            <CardHeader>
              <CardTitle className="text-h2">Editable config JSON</CardTitle>
              <CardDescription className="text-sm">
                Define repos, delivery mode, verification, and per-project init commands that run after checkout and before Pi starts.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {!response?.writable && !loading ? (
                <div className="rounded-lg border border-heat/35 bg-heat/10 p-3 text-sm leading-5 text-heat">
                  <div className="mb-1 flex items-center gap-2 font-medium">
                    <AlertTriangle className="size-3.5" /> Read-only
                  </div>
                  Set `TASKSMITH_CONFIG_PATH` to enable saving config changes from the UI.
                </div>
              ) : null}
              {loading ? (
                <div className="flex h-96 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 motion-safe:animate-spin" /> Loading config...
                </div>
              ) : (
                <Textarea
                  value={text}
                  onChange={(event) => {
                    setText(event.target.value);
                    setSaved(undefined);
                  }}
                  spellCheck={false}
                  className="min-h-[62vh] resize-none font-mono text-sm leading-5"
                  aria-label="TaskSmith config JSON"
                />
              )}
            </CardContent>
          </Card>

          <aside className="space-y-4">
            <Card className={CARD_CLASS}>
              <CardHeader>
                <CardTitle className="text-sm">Init commands</CardTitle>
                <CardDescription className="text-sm">
                  Add `initCommands` to a repo. They run in the per-run workspace before implementation.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-sm leading-5 text-muted-foreground">{`"initCommands": [
  {
    "name": "install",
    "command": "pnpm install --frozen-lockfile",
    "timeoutMs": 300000
  }
]`}</pre>
                <p className="mt-3 text-sm leading-5 text-muted-foreground">
                  TaskSmith also excludes `.env`, `.env.*`, `node_modules/`, and `.pnpm-store/` from Git in each checkout to reduce accidental PR leakage.
                </p>
              </CardContent>
            </Card>

            <Card className={CARD_CLASS}>
              <CardHeader>
                <CardTitle className="text-sm">Delivery</CardTitle>
                <CardDescription className="text-sm">
                  Configure globally or per repo with `workflow.deliveryMode`.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <pre className="overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-sm leading-5 text-muted-foreground">{`"workflow": {
  "type": "single_task_sandcastle",
  "stages": ["plan", "implement", "deep_review", "fix", "deliver"],
  "maxFixAttempts": 1,
  "deliveryMode": "ready_pr"
}`}</pre>
              </CardContent>
            </Card>

            {error ? (
              <div className="rounded-xl border border-destructive/35 bg-destructive/10 p-3 text-sm leading-5 text-destructive">
                <div className="mb-1 flex items-center gap-2 font-medium"><AlertTriangle className="size-3.5" /> Config error</div>
                {error}
              </div>
            ) : null}
            {saved ? (
              <div className="rounded-xl border border-jade/35 bg-jade/10 p-3 text-sm leading-5 text-jade">
                <div className="mb-1 flex items-center gap-2 font-medium"><Check className="size-3.5" /> Saved</div>
                {saved}
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </section>
  );
}
