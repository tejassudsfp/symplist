# Idempotent mutations

Every mutation with side effects requires an `Idempotency-Key` header (architecture §6.1). The
record lives in `idempotency_records`: an HMAC fingerprint of the validated input, a claim while the
first request runs, and the response as a field envelope under the owner's account data key. An
exact retry replays the recorded response with `Idempotency-Replayed: true`; the same key with
another input returns `idempotency.mismatch` (422); a key whose first request has not finished returns
`idempotency.in_progress` (409).

There are two ways to declare an idempotent route. Both require `@Access` and an unsafe method, which
the route-class verifier enforces at bootstrap.

## `@Idempotent()`: the interceptor claims the key

The interceptor claims the key in its own D1 request before the handler runs and records the response
after the handler returns (a second request), or the handler folds only the completion through
`idempotencyContextOf(req).completionStatement(...)`. A client error (an `ApiError` below 500)
releases the claim so a retry runs again; any other failure keeps the claim pending for two minutes,
after which an exact retry may take it over. Use it for mutations whose effects are idempotent by
their own unique keys or write ids (§3.2), so a takeover can never apply an effect twice.

## `@Idempotent({ folded: true })`: exactly once, in one D1 request

For an effectful mutation (§3.1 "Folding"), the handler folds the claim, the effect and the recorded
response into its own deciding batch. D1 runs a batch as one transaction, so the record is either
absent and nothing applied, or completed together with the effect. The interceptor validates the key
and the input and sends no D1 request of its own.

1. `foldedIdempotencyOf(req)` returns the claim for the request.
2. Put `idempotency.statements` first in the batch: the claim insert and the record read.
3. Guard every effect statement with `idempotency.claim.guard.exists` and spread
   `idempotency.claim.guard.params` into its parameters. The guard holds only while this request's
   pending claim owns the key, so a retry, a racing duplicate or another input applies nothing.
4. Add `idempotency.completionStatement({ status, body }, accountKey)`. It records the response
   (redacted to its non-secret fields with status 200 for `@OneTimeSecret([...], { folded: true })`,
   decision R11) and sets the status of the live response.
5. After the batch, call `idempotency.decide(results, accountKey)`. `started` means this request
   applied its effect; `replay` means it applied nothing: return `decision.body` and the interceptor
   sends the recorded status and body. A mismatch or an in-progress record throws the matching error.

A folded claim never takes over a pending record (only an expired one): a pending folded record can
only remain from a batch whose outcome is unknown, so its effect may already have applied. A handler
that returns without folding its claim fails with `internal` and logs `idempotency.fold_incomplete`.

### Worked example

`apps/api/test/probes/idempotency.probe.ts` (`FoldedIdempotencyProbeController.addLabel`):

```ts
@Post("labels")
@Access("admitted")
@Idempotent({ folded: true })
async addLabel(
  @Req() req: Request,
  @CurrentSession() session: SessionContext,
  @Body({ schema: z.strictObject({ label: z.string().trim().min(1).max(40) }) })
  body: { label: string },
) {
  const idempotency = foldedIdempotencyOf(req);
  const accountKey = await this.keys.require(session.userId);
  try {
    const response = { status: 201, body: { label: body.label } };
    const { exists, params } = idempotency.claim.guard;
    const results = await this.db.batch([
      ...idempotency.statements,
      sql(`INSERT INTO probe_effects (label) SELECT :label WHERE ${exists}`, {
        ...params,
        label: body.label,
      }),
      idempotency.completionStatement(response, accountKey),
    ]);
    const decision = idempotency.decide(results, accountKey);
    if (decision.kind === "replay") return decision.body;
    return response.body;
  } finally {
    zeroize(accountKey.key);
  }
}
```

`apps/api/src/common/idempotency/idempotency.interceptor.test.ts` ("folding the claim into the
deciding batch") proves the behavior over real HTTP: the claim, effect and completion travel in one
batch, an exact retry replays without a second effect, another input under the key is refused, five
identical requests racing apply the effect once, invalid input claims nothing, and a handler that
forgets to fold fails closed. The store-level builders (`IdempotencyStore.foldedClaim`,
`completeStatement` and `decideFoldedClaim` in `@symplist/core/idempotency`) are tested in
`packages/core/src/idempotency/store.test.ts` and serve non-HTTP callers, such as the MCP server,
the same way.
