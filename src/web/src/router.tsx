import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
  useRouterState,
} from "@tanstack/react-router";
import { getPublicConfig } from "@/api";
import { Anvil } from "@/components/anvil";
import { ConfigPage } from "@/components/config-page";
import { HomeHero } from "@/components/home-hero";
import { LoginPage } from "@/components/login-page";
import { ProjectRail } from "@/components/project-rail";
import { useRuns } from "@/hooks/use-runs";
import type { ConnectionStatus, RunRecord } from "@/types";

interface ShellContextValue {
  runs: RunRecord[];
  setConnection: (status: ConnectionStatus) => void;
  refreshRuns: () => void;
}

const ShellContext = createContext<ShellContextValue>({
  runs: [],
  setConnection: () => {},
  refreshRuns: () => {},
});

function useShellContext(): ShellContextValue {
  return useContext(ShellContext);
}

function RootShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const isLogin = pathname === "/login";
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const [authEnabled, setAuthEnabled] = useState(false);
  const { runs, loading, refresh } = useRuns({ enabled: !isLogin });

  useEffect(() => {
    if (isLogin) return;
    let cancelled = false;
    void getPublicConfig()
      .then((config) => {
        if (!cancelled) setAuthEnabled(config.auth.enabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [isLogin]);

  const refreshRuns = useCallback(() => {
    void refresh();
  }, [refresh]);

  const shellValue = useMemo<ShellContextValue>(
    () => ({ runs, setConnection, refreshRuns }),
    [refreshRuns, runs],
  );

  if (isLogin) return <Outlet />;

  return (
    <ShellContext.Provider value={shellValue}>
      <div className="flex h-screen min-h-0 overflow-hidden bg-background text-foreground">
        <ProjectRail runs={runs} loading={loading} connection={connection} authEnabled={authEnabled} />
        <main className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </main>
      </div>
    </ShellContext.Provider>
  );
}

const rootRoute = createRootRoute({
  component: RootShell,
});

function HomeRoute() {
  const { runs, setConnection, refreshRuns } = useShellContext();
  useEffect(() => {
    setConnection("idle");
  }, [setConnection]);
  return <HomeHero runs={runs} onCreated={refreshRuns} />;
}

function RunRoute() {
  const { runId } = useParams({ from: "/runs/$runId" });
  const { setConnection, refreshRuns } = useShellContext();
  return <Anvil runId={runId} onConnectionChange={setConnection} onActivity={refreshRuns} />;
}

function ConfigRoute() {
  const { setConnection } = useShellContext();
  useEffect(() => {
    setConnection("idle");
  }, [setConnection]);
  return <ConfigPage />;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: HomeRoute,
});

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: RunRoute,
});

const configRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/config",
  component: ConfigRoute,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginPage,
});

const routeTree = rootRoute.addChildren([indexRoute, runRoute, configRoute, loginRoute]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function AppRouter() {
  return <RouterProvider router={router} />;
}
