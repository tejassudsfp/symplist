// A throwaway local-driver api environment for scripts that boot a built api (the deploy check and
// the local smoke run). Secrets are generated in memory for each run and never written anywhere.
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  generatedSecretBytes,
  generatedSecretFamilies,
  secretFamilyInventory,
} from "../../packages/config/src/secrets.ts";

/**
 * The api environment for `DATA_DRIVER=local`, `EMAIL_DRIVER=log` and `DURABLE=false` (§16.1), with a
 * fresh value for every generated secret family the api holds (§4.5). Only `PATH` is inherited, so
 * nothing from the caller's shell (credentials, a developer's .env values) reaches the process.
 * `LOCAL_DATA_DIR` is the directory for the SQLite file and objects; the api also resolves its default
 * `.local-data` against its working directory, so callers run it with `cwd` at the same place.
 */
export function localApiEnv({ apiPort, webPort, localDataDir, nodeEnv = "development" }) {
  const families = Object.fromEntries(
    generatedSecretFamilies
      .filter((family) => secretFamilyInventory[family].api === "yes")
      .flatMap((family) => [
        [`${family}_1`, randomBytes(generatedSecretBytes).toString("base64url")],
        [`${family}_CURRENT`, "1"],
      ]),
  );
  return {
    PATH: process.env.PATH ?? "",
    NODE_ENV: nodeEnv,
    PORT: String(apiPort),
    WEB_ORIGIN: `http://localhost:${webPort}`,
    API_ORIGIN: `http://localhost:${apiPort}`,
    WS_ORIGIN: `ws://localhost:${apiPort}`,
    // A different hostname from the api and web origins, as the share host must be (§16.3).
    ARTIFACT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    TRUST_PROXY_HOPS: "0",
    DATA_DRIVER: "local",
    EMAIL_DRIVER: "log",
    DURABLE: "false",
    KEY_PROVIDER: "env",
    EMAIL_FROM_SECURITY: "Symplist <security@example.test>",
    EMAIL_FROM_REMINDERS: "Symplist <reminders@example.test>",
    LOCAL_DATA_DIR: localDataDir,
    ...families,
  };
}

/** A TCP port that was free on the loopback interface when asked. */
export async function freePort() {
  const server = createServer();
  await new Promise((settle, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", settle);
  });
  const { port } = server.address();
  await new Promise((settle) => server.close(settle));
  return port;
}
