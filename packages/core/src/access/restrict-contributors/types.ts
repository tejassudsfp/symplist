import type { Statement } from "@symplist/db";
import type { CoreDomain } from "../../domains.ts";
import type { RestrictInput } from "../service.ts";

/**
 * A domain's contribution to the restriction batch (§5.5). Every statement is guarded by
 * `input.writeId` and never updates `users`.
 */
export interface RestrictContributor {
  readonly domain: CoreDomain;
  statements(input: RestrictInput): readonly Statement[];
}
