import { decryptFieldText, idempotencyResponseContext, zeroize } from "@symplist/crypto";
import { sql } from "@symplist/db";
import { expect } from "vitest";
import type { TestApp, TestResponse } from "./harness.ts";

/** §6.1: scan all tables and object bytes, not just the feature's own records. */
export async function assertSecretAbsent(
  app: TestApp,
  secrets: readonly string[],
  responses: readonly TestResponse[] = [],
) {
  expect(secrets.length).toBeGreaterThan(0);
  const records = await app.db.all(
    sql(
      "SELECT user_id,scope,key,response_enc FROM idempotency_records WHERE response_enc IS NOT NULL",
    ),
  );
  const decrypted: string[] = [];
  for (const record of records) {
    expect(record.response_enc).toMatch(/^sym1\./);
    const key = await app.accountKeys.require(String(record.user_id));
    try {
      decrypted.push(
        decryptFieldText(
          key,
          idempotencyResponseContext(
            String(record.user_id),
            String(record.scope),
            String(record.key),
          ),
          String(record.response_enc),
        ),
      );
    } finally {
      zeroize(key.key);
    }
  }
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThanOrEqual(6);
    expect(await app.scanDatabaseFor(secret), "raw D1 secret scan").toEqual([]);
    expect(app.scanObjectsFor(secret), "R2 body and metadata scan").toEqual([]);
    expect(app.logs.text(), "captured operational logs").not.toContain(secret);
    expect(decrypted.join("\n"), "decrypted idempotency responses").not.toContain(secret);
    for (const response of responses) {
      expect(response.text, "non-minting response body").not.toContain(secret);
      expect(JSON.stringify([...response.headers]), "non-minting response headers").not.toContain(
        secret,
      );
    }
  }
  return records.length;
}

export function issuedCookie(response: TestResponse, name: string) {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`))
    ?.split(";")[0];
  expect(cookie, "a real HTTP cookie must have been issued").toBeDefined();
  const token = cookie?.slice(name.length + 1) ?? "";
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return { cookie: cookie ?? "", token };
}
