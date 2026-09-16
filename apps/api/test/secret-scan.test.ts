import { encryptFieldText, idempotencyResponseContext, zeroize } from "@symplist/crypto";
import { sql } from "@symplist/db";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApp, type TestApp } from "./harness.ts";
import { assertSecretAbsent } from "./secret-scan.ts";

const apps: TestApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe("secret scanner positive controls", () => {
  it.each([
    "database",
    "object",
    "object-metadata",
    "log",
    "encrypted-response",
    "response",
    "headers",
  ] as const)("detects a canary deliberately leaked into %s", async (sink) => {
    const app = await bootTestApp();
    apps.push(app);
    const owner = await app.createSignedInUser();
    const canary = "FAKE-SCANNER-POSITIVE-CONTROL-53c41d9a";
    const key = await app.accountKeys.require(owner.id);
    let response: string;
    try {
      response = encryptFieldText(
        key,
        idempotencyResponseContext(owner.id, "scanner", "fixture"),
        JSON.stringify({ status: sink === "encrypted-response" ? canary : "safe" }),
      );
    } finally {
      zeroize(key.key);
    }
    await app.db.run(
      sql(
        "INSERT INTO idempotency_records(scope,user_id,key,fingerprint,fingerprint_version,status,http_status,response_enc,created_at,updated_at,expires_at,write_id) VALUES('scanner',:owner,'fixture','test-fingerprint',1,'completed',200,:response,0,0,9999999999999,'fixture')",
        { owner: owner.id, response },
      ),
    );
    if (sink === "database")
      await app.db.run(
        sql("UPDATE users SET display_name_enc=:value WHERE id=:id", {
          value: canary,
          id: owner.id,
        }),
      );
    if (sink === "object")
      await app.objects.put({ key: `u/${owner.id}/scanner-canary`, body: Buffer.from(canary) });
    if (sink === "object-metadata")
      await app.objects.put({
        key: `u/${owner.id}/scanner-canary`,
        body: Buffer.from("safe"),
        metadata: { canary },
      });
    if (sink === "log") app.logs.write(JSON.stringify({ event: "scanner.canary", value: canary }));
    if (sink === "encrypted-response") expect(await app.scanDatabaseFor(canary)).toEqual([]);
    const http = await app.get("/healthz");
    const responseHeaders = new Headers(http.headers);
    if (sink === "headers") responseHeaders.set("x-test-secret", canary);
    const samples = [
      { ...http, text: sink === "response" ? canary : http.text, headers: responseHeaders },
    ];
    const expectedFailure = {
      database: "raw D1 secret scan",
      object: "R2 body and metadata scan",
      "object-metadata": "R2 body and metadata scan",
      log: "captured operational logs",
      "encrypted-response": "decrypted idempotency responses",
      response: "non-minting response body",
      headers: "non-minting response headers",
    }[sink];
    await expect(assertSecretAbsent(app, [canary], samples)).rejects.toThrow(expectedFailure);
  });
});
