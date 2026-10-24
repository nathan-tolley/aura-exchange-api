import { config } from "./config.js";
import { pool } from "./db.js";
import { buildApp } from "./app.js";
import { assertMigrationsCurrent } from "./services/migration-service.js";

await assertMigrationsCurrent(pool);
const app = await buildApp();
await app.listen({ host: "0.0.0.0", port: config.PORT });
