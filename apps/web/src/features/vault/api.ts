"use client";
import {
  idSchema,
  otpChallengeResponseSchema,
  type VaultGrantRequest,
  type VaultItemContent,
  vaultGrantResponseSchema,
  vaultItemSchema,
  vaultItemsResponseSchema,
  vaultResetAuthorizationSchema,
  vaultStatusSchema,
} from "@symplist/contracts";
import { z } from "zod";
import { type ApiClient, getApiClient } from "@/lib/api";

const changed = z.object({ id: idSchema, version: z.number().int() });
export function createVaultApi(client: ApiClient) {
  return {
    status: () => client.get("/v1/vault", { schema: vaultStatusSchema }),
    setup: (passphrase: string, confirmation: string, key: string) =>
      client.post("/v1/vault/setup", { body: { passphrase, confirmation }, idempotencyKey: key }),
    unlock: (passphrase: string, key: string) =>
      client.post("/v1/vault/unlock", { body: { passphrase }, idempotencyKey: key }),
    lock: () => client.post("/v1/vault/lock"),
    touch: () =>
      client.post("/v1/vault/touch", { schema: z.object({ idleExpiresAt: z.number().int() }) }),
    list: (cursor?: string) =>
      client.get("/v1/vault/items", { schema: vaultItemsResponseSchema, query: { cursor } }),
    read: (id: string) =>
      client.get(`/v1/vault/items/${idSchema.parse(id)}`, { schema: vaultItemSchema }),
    save: (body: VaultItemContent, key: string, existing?: { id: string; version: number }) =>
      existing
        ? client.put(`/v1/vault/items/${idSchema.parse(existing.id)}`, {
            body: { ...body, version: existing.version },
            idempotencyKey: key,
            schema: changed,
          })
        : client.post("/v1/vault/items", { body, idempotencyKey: key, schema: changed }),
    remove: (id: string, version: number, key: string) =>
      client.delete(`/v1/vault/items/${idSchema.parse(id)}`, {
        body: { version },
        idempotencyKey: key,
      }),
    sendCode: () => client.post("/v1/vault/reset/otp", { schema: otpChallengeResponseSchema }),
    verify: (challengeId: string, code: string) =>
      client.post("/v1/vault/reset/verify", {
        body: { challengeId, code },
        schema: vaultResetAuthorizationSchema,
      }),
    reset: (authorizationId: string, passphrase: string, confirmation: string, key: string) =>
      client.post("/v1/vault/reset", {
        body: { authorizationId, passphrase, confirmation },
        idempotencyKey: key,
      }),
    grant: (body: VaultGrantRequest, key: string) =>
      client.post("/v1/vault/grants", {
        body,
        idempotencyKey: key,
        schema: vaultGrantResponseSchema,
      }),
  };
}
export type VaultApi = ReturnType<typeof createVaultApi>;
let shared: VaultApi | undefined;
export function getVaultApi() {
  shared ??= createVaultApi(getApiClient());
  return shared;
}
export function vaultMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const messages: Record<string, string> = {
    "vault.incorrect_key": "That key did not unlock the vault. Try again.",
    "vault.throttled": "Too many attempts. Wait before trying again. Your items are unchanged.",
    "vault.key_weak": "Use a longer key. A memorable phrase works well.",
    "vault.conflict":
      "This item changed on another device. Your draft is kept; reload the saved version before editing again.",
    "vault.reset_expired":
      "Verification expired or the key changed elsewhere. Request a fresh reset code. Your items are unchanged.",
    "vault.already_created": "Your vault was set up on another device. Unlock the existing vault.",
    "otp.incorrect": "That code is incorrect. Try again.",
    "otp.expired": "This code expired. Request a fresh code.",
    "otp.locked": "Too many attempts. Wait before requesting another code.",
    "otp.attempts_exhausted": "Too many attempts. Request a fresh code when the wait ends.",
    "otp.cooldown": "Wait a minute before requesting another code.",
    "auth.session_required": "Your sign-in session expired. Sign in again.",
  };
  return (
    messages[code] ??
    "Couldn’t finish that request. Try again. Your changes have not been discarded."
  );
}
export function vaultIsLocked(error: unknown) {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      ["vault.locked", "auth.session_required", "access.relocked", "access.suspended"].includes(
        String(error.code),
      ),
  );
}
