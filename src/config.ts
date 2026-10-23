import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { z } from "zod";

if (existsSync(".env")) loadEnvFile(".env");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  APP_ORIGIN: z.string().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1).default("postgres://aura:aura_dev_password@localhost:5432/aura_exchange"),
  SESSION_SECRET: z.string().min(16).default("development-only-session-secret-change-me"),
  SETUP_TOKEN: z.string().min(8).default("change-this-setup-token"),
  AI_PROVIDER: z.enum(["openai", "fake"]).default("fake"),
  OPENAI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default("gpt-6-astra"),
  WORKER_POLL_MS: z.coerce.number().int().min(250).default(2000),
  TZ: z.string().default("America/New_York")
});

export const config = schema.parse(process.env);
if (config.NODE_ENV === "production") {
  if (config.SESSION_SECRET === "development-only-session-secret-change-me") {
    throw new Error("SESSION_SECRET must be changed in production");
  }
  if (config.SETUP_TOKEN === "change-this-setup-token") {
    throw new Error("SETUP_TOKEN must be changed in production");
  }
}
export const isProduction = config.NODE_ENV === "production";

