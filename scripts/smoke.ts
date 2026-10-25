import { expectResponseMatchesSpec } from "../tests/contract/openapi.js";

/**
 * pnpm smoke --base https://tae.app.elicit-marketing.com
 *
 * Checks a deployed server from the outside: HTTPS verifies, /v1 answers what openapi/v1.yaml says, the worker is
 * alive, and the console's health check answers. Exits non-zero on the first failure. Reads only; never signs in.
 */

function baseUrl(argv: string[]): string {
  const args = argv.filter((arg) => arg !== "--");
  const at = args.indexOf("--base");
  const base = at >= 0 ? args[at + 1] : process.env.SMOKE_BASE;
  if (!base) throw new Error("Usage: pnpm smoke --base https://host");
  return base.replace(/\/+$/, "");
}

async function check(name: string, run: () => Promise<string>): Promise<boolean> {
  try {
    console.log(`ok    ${name}: ${await run()}`);
    return true;
  } catch (error) {
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function main(): Promise<void> {
  const base = baseUrl(process.argv.slice(2));
  console.log(`Smoke test of ${base}`);
  const results = [
    await check("GET /v1/health", async () => {
      const { status, body } = await getJson(`${base}/v1/health`);
      if (status !== 200) throw new Error(`status ${status}`);
      expectResponseMatchesSpec("get", "/health", 200, body);
      const health = body as { status: string; lastGoodUpdate: string | null; minBuild: number };
      if (health.status !== "OK") throw new Error(`status ${health.status} (DEGRADED means the worker heartbeat is missing or stale)`);
      return `OK, minBuild ${health.minBuild}, worker heartbeat ${health.lastGoodUpdate}`;
    }),
    await check("version gate (X-App-Build: 0)", async () => {
      const { status, body } = await getJson(`${base}/v1/health`, { "X-App-Build": "0" });
      if (status !== 426) throw new Error(`status ${status}, expected 426`);
      expectResponseMatchesSpec("get", "/health", 426, body);
      return "426 UPDATE_REQUIRED";
    }),
    await check("GET /v1/me without a token", async () => {
      const { status, body } = await getJson(`${base}/v1/me`);
      if (status !== 401) throw new Error(`status ${status}, expected 401`);
      expectResponseMatchesSpec("get", "/me", 401, body);
      return `401 ${(body as { error: { code: string } }).error.code}`;
    }),
    await check("console GET /healthz", async () => {
      const { status } = await getJson(`${base}/healthz`);
      if (status !== 200) throw new Error(`status ${status}`);
      return "200";
    })
  ];
  if (results.includes(false)) process.exit(1);
}

await main();
