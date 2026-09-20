import { randomBytes } from "node:crypto";
import {
  computeDigest,
  createKeyProvider,
  encryptObject,
  generateToken,
  type KeyProvider,
  zeroize,
} from "@symplist/crypto";
import { int, sql, uuidv7 } from "@symplist/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDocumentsTestEnvironment,
  type DocumentsTestEnvironment,
} from "../documents/test-support.ts";
import { artifactObjectContext, sharingEncrypt } from "./fields.ts";
import { SharingReader } from "./reader.ts";
import { SharingRepository } from "./repository.ts";

describe("artifact read freshness", () => {
  let env: DocumentsTestEnvironment;
  let supplemental: ReturnType<typeof createKeyProvider>;
  let reader: SharingReader;
  let owner: string;
  let artifact: string;
  let grant: string;
  let publication: string;
  const marker = "PRIVATE-READER-RACE-MARKER";

  beforeEach(async () => {
    env = await createDocumentsTestEnvironment();
    supplemental = createKeyProvider(
      {
        SHARE_DIGEST_SECRET: { current: 1, versions: new Map([[1, randomBytes(32)]]) },
        SHARE_SESSION_DIGEST_SECRET: {
          current: 1,
          versions: new Map([[1, randomBytes(32)]]),
        },
      },
      { required: ["SHARE_DIGEST_SECRET", "SHARE_SESSION_DIGEST_SECRET"] },
    );
    const supplementalFamilies = new Set(["SHARE_DIGEST_SECRET", "SHARE_SESSION_DIGEST_SECRET"]);
    const keys: KeyProvider = {
      current: (family) =>
        supplementalFamilies.has(family) ? supplemental.current(family) : env.keys.current(family),
      get: (family, version) =>
        supplementalFamilies.has(family)
          ? supplemental.get(family, version)
          : env.keys.get(family, version),
      all: (family) =>
        supplementalFamilies.has(family) ? supplemental.all(family) : env.keys.all(family),
    };
    owner = await env.createUser();
    const task = await env.createTask(owner);
    artifact = uuidv7();
    grant = uuidv7();
    publication = uuidv7();
    const objectKey = `u/${owner}/artifacts/${artifact}.md.sym`;
    const repository = new SharingRepository({
      db: env.db,
      objects: env.objects,
      keys,
      now: () => env.clock,
      policy: { betaAccessRequired: true },
      artifactOrigin: "https://artifacts.example.test",
    });
    const key = await repository.accountKeys.require(owner);
    try {
      await env.objects.put({
        key: objectKey,
        body: encryptObject(key, artifactObjectContext(owner, artifact), Buffer.from(marker)),
      });
      await env.db.batch([
        sql(
          `INSERT INTO artifacts(id,owner_id,task_id,kind,title_enc,source_revision,selection_json,object_key,bytes,request_id,fingerprint_enc,created_at,write_id)
          VALUES(:id,:owner,:task,'document',:title,:revision,'[]',:object,:bytes,:request,:fingerprint,:now,:write)`,
          {
            id: artifact,
            owner,
            task,
            title: sharingEncrypt(key, "artifacts", artifact, "title_enc", "Reviewed brief"),
            revision: "fixture-revision",
            object: objectKey,
            bytes: int(Buffer.byteLength(marker)),
            request: "reader-race-fixture",
            fingerprint: sharingEncrypt(
              key,
              "artifacts",
              artifact,
              "fingerprint_enc",
              "fixture-fingerprint",
            ),
            now: int(env.clock),
            write: uuidv7(),
          },
        ),
        sql(
          `INSERT INTO share_grants(id,owner_id,artifact_id,mode,publication_id,created_at,write_id)
          VALUES(:id,:owner,:artifact,'public',:publication,:now,:write)`,
          {
            id: grant,
            owner,
            artifact,
            publication,
            now: int(env.clock),
            write: uuidv7(),
          },
        ),
      ]);
    } finally {
      zeroize(key.key);
    }
    reader = new SharingReader(repository);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    supplemental.destroy();
    await env.close();
  });

  it("returns content when the exact grant, artifact, owner and key remain current", async () => {
    await expect(
      reader.read({ artifactId: artifact, publicationId: publication }),
    ).resolves.toEqual(
      expect.objectContaining({ kind: "content", title: "Reviewed brief", markdown: marker }),
    );
  });

  it.each(["grant", "restriction", "artifact", "key"] as const)(
    "rejects when %s authority changes after ciphertext retrieval",
    async (change) => {
      const get = env.objects.get.bind(env.objects);
      let changed = false;
      vi.spyOn(env.objects, "get").mockImplementationOnce(async (objectKey) => {
        const stored = await get(objectKey);
        changed = true;
        if (change === "grant") {
          await env.db.run(
            sql(
              "UPDATE share_grants SET status='revoked',generation=generation+1,write_id=:write WHERE id=:grant",
              { grant, write: uuidv7() },
            ),
          );
        } else if (change === "restriction") {
          await env.relock(owner);
        } else if (change === "artifact") {
          await env.db.run(
            sql("UPDATE artifacts SET deleted_at=:now WHERE id=:artifact", {
              artifact,
              now: int(env.clock),
            }),
          );
        } else {
          await env.db.run(
            sql("UPDATE account_keys SET wrapped_key='replaced' WHERE owner_id=:owner", { owner }),
          );
        }
        return stored;
      });
      await expect(
        reader.read({ artifactId: artifact, publicationId: publication }),
      ).rejects.toMatchObject({ code: "sharing.unavailable" });
      expect(changed).toBe(true);
    },
  );

  it("rejects when the exact password session is revoked after ciphertext retrieval", async () => {
    const token = generateToken();
    const tokenDigest = computeDigest(
      reader.repository.options.keys,
      "SHARE_DIGEST_SECRET",
      "share-token",
      token,
    );
    const sessionToken = generateToken();
    const sessionDigest = computeDigest(
      reader.repository.options.keys,
      "SHARE_SESSION_DIGEST_SECRET",
      "share-session",
      sessionToken,
    );
    const passwordGrant = uuidv7();
    const session = uuidv7();
    await env.db.batch([
      sql(
        `INSERT INTO share_grants(id,owner_id,artifact_id,mode,token_digest,token_version,password_hash,expires_at,created_at,write_id)
        VALUES(:id,:owner,:artifact,'password',:digest,:version,'fixture',:expires,:now,:write)`,
        {
          id: passwordGrant,
          owner,
          artifact,
          digest: tokenDigest.digest,
          version: int(tokenDigest.version),
          expires: int(env.clock + 86_400_000),
          now: int(env.clock),
          write: uuidv7(),
        },
      ),
      sql(
        `INSERT INTO share_sessions(id,owner_id,grant_id,grant_generation,digest,digest_version,expires_at,created_at,write_id)
        VALUES(:id,:owner,:grant,1,:digest,:version,:expires,:now,:write)`,
        {
          id: session,
          owner,
          grant: passwordGrant,
          digest: sessionDigest.digest,
          version: int(sessionDigest.version),
          expires: int(env.clock + 43_200_000),
          now: int(env.clock),
          write: uuidv7(),
        },
      ),
    ]);
    const get = env.objects.get.bind(env.objects);
    vi.spyOn(env.objects, "get").mockImplementationOnce(async (objectKey) => {
      const stored = await get(objectKey);
      await env.db.run(
        sql("UPDATE share_sessions SET revoked_at=:now,write_id=:write WHERE id=:session", {
          session,
          now: int(env.clock),
          write: uuidv7(),
        }),
      );
      return stored;
    });
    await expect(
      reader.read({
        artifactId: artifact,
        key: token,
        cookies: { [`__Host-sym_share_${passwordGrant}`]: sessionToken },
      }),
    ).rejects.toMatchObject({ code: "sharing.unavailable" });
  });
});
