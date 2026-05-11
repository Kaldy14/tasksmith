import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createTaskSmithAuthService } from "../src/auth/tasksmith-auth.js";
import type { AppConfig } from "../src/domain/types.js";
import { loadConfig } from "../src/server/config.js";
import { PostgresMetadataIndex } from "../src/storage/postgres-metadata-index.js";
import { authSchema, user } from "../src/storage/postgres-schema.js";

const email = readRequiredEnv("TASKSMITH_BOOTSTRAP_ADMIN_EMAIL").toLowerCase();
const password = readRequiredEnv("TASKSMITH_BOOTSTRAP_ADMIN_PASSWORD");
const name = process.env.TASKSMITH_BOOTSTRAP_ADMIN_NAME?.trim() || "TaskSmith Admin";

if (password.length < 12) throw new Error("TASKSMITH_BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters");

const baseConfig = loadConfig();
const databaseUrl = baseConfig.databaseUrl;
if (!databaseUrl) throw new Error("TASKSMITH_DATABASE_URL is required");
if (!baseConfig.auth.secret) throw new Error("TASKSMITH_AUTH_SECRET or BETTER_AUTH_SECRET is required");

const config: AppConfig = {
  ...baseConfig,
  auth: { ...baseConfig.auth, enabled: true },
};

const index = new PostgresMetadataIndex(databaseUrl);
await index.init();
await index.close();

const pool = new Pool({ connectionString: databaseUrl, application_name: "tasksmith-auth-bootstrap" });
const db = drizzle(pool, { schema: authSchema });
try {
  const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (existing.length > 0) {
    console.log(`TaskSmith admin already exists: ${email}`);
    process.exit(0);
  }
} finally {
  await pool.end();
}

const auth = createTaskSmithAuthService(config, { allowSignUp: true });
if (!auth) throw new Error("Failed to initialize TaskSmith auth");
try {
  await auth.auth.api.signUpEmail({
    body: {
      name,
      email,
      password,
      rememberMe: false,
    },
  });
  console.log(`Created TaskSmith admin: ${email}`);
} finally {
  await auth.close();
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
