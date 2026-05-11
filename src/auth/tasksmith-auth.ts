import { betterAuth, type Auth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AppConfig } from "../domain/types.js";
import { authSchema } from "../storage/postgres-schema.js";

export interface AuthSession {
  session: { id: string; userId: string; expiresAt: Date };
  user: { id: string; email: string; name: string; image?: string | null };
}

export interface TaskSmithAuthOptions {
  allowSignUp?: boolean;
}

export class TaskSmithAuthService {
  readonly auth: Auth;
  private readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  private readonly pool: Pool;

  constructor(auth: Auth, pool: Pool) {
    this.auth = auth;
    this.pool = pool;
    this.handler = toNodeHandler(auth.handler);
  }

  async handleNode(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.handler(req, res);
  }

  async getSession(headers: IncomingHttpHeaders): Promise<AuthSession | null> {
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(headers) });
    return session as AuthSession | null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createTaskSmithAuthService(
  config: AppConfig,
  options: TaskSmithAuthOptions = {},
): TaskSmithAuthService | undefined {
  if (!config.auth.enabled) return undefined;
  if (!config.databaseUrl) throw new Error("TaskSmith auth requires TASKSMITH_DATABASE_URL");
  if (!config.auth.secret) throw new Error("TaskSmith auth requires TASKSMITH_AUTH_SECRET or BETTER_AUTH_SECRET");
  if (Buffer.byteLength(config.auth.secret, "utf8") < 32) throw new Error("TaskSmith auth secret must be at least 32 bytes");

  const pool = new Pool({
    connectionString: config.databaseUrl,
    application_name: "tasksmith-auth",
  });
  const db: NodePgDatabase<typeof authSchema> = drizzle(pool, { schema: authSchema });
  const auth = betterAuth({
    appName: "TaskSmith",
    baseURL: config.auth.baseUrl,
    trustedOrigins: config.auth.trustedOrigins,
    secret: config.auth.secret,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: authSchema,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: options.allowSignUp !== true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      autoSignIn: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    advanced: {
      cookiePrefix: "tasksmith",
      useSecureCookies: config.auth.baseUrl.startsWith("https://"),
      defaultCookieAttributes: {
        sameSite: "lax",
      },
    },
  });

  return new TaskSmithAuthService(auth as Auth, pool);
}
