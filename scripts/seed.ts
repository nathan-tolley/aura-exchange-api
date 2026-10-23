import { randomBytes } from "node:crypto";
import { hashPassword, hashToken } from "../src/auth.js";
import { pool, one, withTransaction } from "../src/db.js";
import { accounts, postLedgerTransaction } from "../src/core/ledger.js";

const ownerPassword = process.env.OWNER_PASSWORD ?? "ChangeMeAura123!";

await withTransaction(async (client) => {
  const count = await client.query<{ count: string }>("SELECT COUNT(*)::text AS count FROM users");
  if (Number(count.rows[0]?.count) > 0) {
    console.log("Seed skipped: users already exist");
    return;
  }
  const owner = await one<{ id: string }>(client,
    "INSERT INTO users(username,password_hash,role) VALUES ('owner',$1,'OWNER') RETURNING id", [await hashPassword(ownerPassword)]
  );
  const ownerStock = await one<{ id: string }>(client,
    `INSERT INTO person_stocks(display_name,ticker,owner_user_id,is_active,claimed_at,consented_at)
     VALUES ('Exchange Owner','OWNR',$1,true,now(),now()) RETURNING id`, [owner.id]
  );
  const season = await one<{ id: string }>(client,
    "INSERT INTO seasons(season_number,name,starts_at,ends_at) VALUES (1,'Season 1',now(),now()+interval '8 weeks') RETURNING id"
  );
  await client.query("INSERT INTO market_pools(season_id,stock_id) VALUES ($1,$2)", [season.id, ownerStock.id]);
  await postLedgerTransaction(client, "SEASON_GRANT", "Initial season balance", [
    { accountKey: accounts.userCash(owner.id, season.id), amount: 10_000 },
    { accountKey: accounts.issuance(season.id), amount: -10_000 }
  ], owner.id);
  for (const person of [
    { name: "Jordan Blake", ticker: "JBLK" },
    { name: "Maya Chen", ticker: "MAYA" },
    { name: "Theo Brooks", ticker: "THEO" }
  ]) {
    const stock = await one<{ id: string }>(client,
      "INSERT INTO person_stocks(display_name,ticker) VALUES ($1,$2) RETURNING id", [person.name, person.ticker]
    );
    const code = randomBytes(6).toString("base64url").toUpperCase();
    await client.query(
      "INSERT INTO invites(person_stock_id,code_hash,expires_at,created_by) VALUES ($1,$2,now()+interval '30 days',$3)",
      [stock.id, hashToken(code), owner.id]
    );
    console.log(`${person.name} claim code: ${code}`);
  }
});

console.log("Owner username: owner");
console.log(`Owner password: ${ownerPassword}`);
await pool.end();

