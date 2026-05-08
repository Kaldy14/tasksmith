import { createContext, useCallback, useContext, useMemo, useState } from "react";
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
} from "@tanstack/react-router";
import { Anvil } from "@/components/anvil";
import { ProjectRail } from "@/components/project-rail";
import { useRuns } from "@/hooks/use-runs";
import type { ConnectionStatus } from "@/types";

interface ShellContextValue {
  setConnection: (status: ConnectionStatus) => void;
  refreshRuns: () => void;
}

const ShellContext = createContext<ShellContextValue>({
  setConnection: () => {},
  refreshRuns: () => {},
});

function useShellContext(): ShellContextValue {
  return useContext(ShellContext);
}

function RootShell() {
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const { runs, loading, refresh } = useRuns();

  const refreshRuns = useCallback(() => {
    void refresh();
  }, [refresh]);

  const shellValue = useMemo<ShellContextValue>(
    () => ({ setConnection, refreshRuns }),
    [refreshRuns],
  );

  return (
    <ShellContext.Provider value={shellValue}>
      <div className="flex h-screen min-h-0 overflow-hidden bg-background text-foreground">
        <ProjectRail
          runs={runs}
          loading={loading}
          connection={connection}
          onCreated={refreshRuns}
        />
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
  const { setConnection, refreshRuns } = useShellContext();
  return <Anvil runId={undefined} onConnectionChange={setConnection} onActivity={refreshRuns} />;
}

function RunRoute() {
  const { runId } = useParams({ from: "/runs/$runId" });
  const { setConnection, refreshRuns } = useShellContext();
  return <Anvil runId={runId} onConnectionChange={setConnection} onActivity={refreshRuns} />;
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

const routeTree = rootRoute.addChildren([indexRoute, runRoute]);

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
