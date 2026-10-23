import type { PoolClient } from "pg";
import { Decimal } from "decimal.js";
import { randomUUID } from "node:crypto";

export interface Posting {
  accountKey: string;
  amount: Decimal.Value;
}

export async function postLedgerTransaction(
  client: PoolClient,
  kind: string,
  description: string,
  postings: Posting[],
  referenceId?: string
): Promise<string> {
  if (postings.length < 2) throw new Error("A ledger transaction needs at least two postings");
  const normalized = postings.map((item) => ({ ...item, amount: new Decimal(item.amount).toDecimalPlaces(8) }));
  const total = normalized.reduce<Decimal>((sum, item) => sum.plus(item.amount), new Decimal(0));
  if (total.abs().gt("0.00000005")) throw new Error(`Unbalanced ledger transaction: ${total.toString()}`);
  if (!total.isZero()) {
    const last = normalized.at(-1)!;
    last.amount = new Decimal(last.amount).minus(total);
  }

  const transactionId = randomUUID();
  await client.query(
    "INSERT INTO ledger_transactions(id, kind, reference_id, description) VALUES ($1, $2, $3, $4)",
    [transactionId, kind, referenceId ?? null, description]
  );
  for (const posting of normalized) {
    await client.query(
      "INSERT INTO cash_ledger_entries(transaction_id, account_key, amount) VALUES ($1, $2, $3)",
      [transactionId, posting.accountKey, new Decimal(posting.amount).toFixed(8)]
    );
  }
  return transactionId;
}

export async function accountBalance(client: PoolClient, accountKey: string): Promise<Decimal> {
  const result = await client.query<{ balance: string }>(
    "SELECT COALESCE(SUM(amount), 0)::text AS balance FROM cash_ledger_entries WHERE account_key = $1",
    [accountKey]
  );
  return new Decimal(result.rows[0]?.balance ?? 0);
}

export const accounts = {
  userCash: (userId: string, seasonId: string) => `USER:${userId}:CASH:${seasonId}`,
  poolCash: (stockId: string, seasonId: string) => `POOL:${stockId}:CASH:${seasonId}`,
  shortEscrow: (userId: string, stockId: string, seasonId: string) => `ESCROW:${userId}:${stockId}:${seasonId}`,
  limitEscrow: (orderId: string, seasonId: string) => `LIMIT:${orderId}:CASH:${seasonId}`,
  fees: (seasonId: string) => `SYSTEM:FEES:${seasonId}`,
  issuance: (seasonId: string) => `SYSTEM:ISSUANCE:${seasonId}`
};

