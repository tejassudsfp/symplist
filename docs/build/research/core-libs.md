# Core libraries research (verified 2026-09-15)

Scope: libraries and runtime features for Symplist's domain logic in Node 24 (NestJS on Render, Trigger.dev `node-24` tasks) and, where noted, the browser (Next.js on Vercel). Topics: Argon2id, AES-256-GCM envelope encryption and HKDF, Git plumbing for per-task bare repositories, Markdown parsing and safe HTML, search, dates and time zones, the page editor, and ID generation.

How this was checked:
- Versions, peers, engines, licences and publish dates come from `npm view` on 2026-09-15.
- API facts come from the official docs linked in each section. Where a docs site would not render, facts were taken from the upstream project's docs source on GitHub or from the published `.d.ts` files, and this is stated.
- Snippets were run on Node 24 and type-checked with `tsc` 7.0.2 in a throwaway project under the session scratchpad (`research/core-libs/`). The editors were run headless in jsdom; the React components were type-checked only. Settings: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`, `skipLibCheck: false`, `module/moduleResolution: nodenext`.
- A second project checked CommonJS output (NestJS style, with decorators). A third checked the React 19 editor components (`moduleResolution: bundler`, `jsx: react-jsx`).
- Any result that failed was re-run with `typescript@6.0.3` to see whether TypeScript 7 caused it.
- Runtimes used: local macOS arm64 with Node 24.15.0 (OpenSSL 3.6.4) and Apple Git 2.50.1. Trigger.dev's exact `node-24` runtime base image (`triggerdotdev/node:24-bookworm@sha256:d2d0c018…`, pinned in `trigger.dev@4.6.0` `deploy/buildImage.js`) ships Node 24.18.0, OpenSSL 3.5.7 and Git 2.39.5 (Debian `1:2.39.5-0+deb12u3`, preinstalled). `node:24-bookworm-slim` was run as `linux/amd64` (Node 24.21.0, OpenSSL 3.5.8, glibc 2.36).

## Versions

| Package | Version | Peer / engine notes |
| --- | --- | --- |
| `node:crypto` (built in) | Node 24 LTS | `crypto.argon2()` / `argon2Sync()` added in v24.7.0 (no stability downgrade, so it inherits Stable). WebCrypto `Argon2id` (v24.8.0) sits under "Modern Algorithms", Stability 1.1, and needs OpenSSL >= 3.2. The official Node 24 builds bundle OpenSSL 3.5/3.6. |
| `hash-wasm` | 4.12.0 (2024-11-19) | MIT, zero dependencies, no engines field, CJS + ESM, `sideEffects: false`. The WASM is inlined as base64. The last release was 22 months ago (repository last pushed 2024-11-19). |
| `@node-rs/argon2` | 2.2.1 (2026-09-10) | MIT, engines `node >= 10`. Prebuilt optional deps include `-linux-x64-gnu` (libc glibc), `-linux-x64-musl`, `-darwin-arm64` and `-linux-arm64-gnu`. The `browser` field points to `@node-rs/argon2-wasm32-wasi` 2.2.1, which uses shared `WebAssembly.Memory` and workers and depends on `@emnapi/core`/`@emnapi/runtime` `2.0.0-alpha.5` (prerelease). Types declare `const enum Algorithm`. |
| `argon2` | 0.45.1 (2026-07-21) | MIT, engines `>=16.17.0` (README says Node >= 22). It has an `install` script (`node-gyp-build`), so pnpm 12 needs an `allowBuilds` entry. Prebuilds for linux-x64 glibc/musl and darwin-arm64 still load when the script is skipped (verified with `--ignore-scripts` on linux/amd64). Node only. |
| `unified` | 11.0.5 | MIT, ESM only, no peers. |
| `remark-parse` | 11.0.0 | MIT, ESM only. |
| `remark-gfm` | 4.0.1 | MIT, ESM only; needs remark-parse 11+. |
| `remark-rehype` | 11.1.2 | MIT, ESM only; `allowDangerousHtml` defaults to false. |
| `remark-stringify` | 11.0.0 | MIT, ESM only (options from `mdast-util-to-markdown` 2.1.2). |
| `mdast-util-from-markdown` | 2.0.3 (2026-02-21) | MIT, ESM only. Use with `micromark-extension-gfm` 3.0.0 and `mdast-util-gfm` 3.1.0. |
| `mdast-util-to-string` / `@types/mdast` | 4.0.0 / 4.0.4 | MIT. |
| `rehype-sanitize` | 6.0.0 | MIT, ESM only (`hast-util-sanitize` 5.0.2). |
| `rehype-stringify` | 10.0.1 | MIT, ESM only. |
| `minisearch` | 7.2.0 (2025-09-16) | MIT, ESM + CJS entry, bundled types, no deps. `next` tag `5.0.0-beta1` is old; ignore it. |
| `flexsearch` | 0.8.212 (2025-09-06) | Apache-2.0. The bundled `index.d.ts` fails `skipLibCheck: false` (4× TS2344) on both TS 7.0.2 and TS 6.0.3. |
| `@orama/orama` | 3.1.18 (2025-12-19) | Apache-2.0, engines `node >= 20`. `@orama/plugin-data-persistence` 3.1.18. |
| `temporal-polyfill` | 1.0.5 (2026-09-11) | MIT, ESM only. Deps `temporal-spec` 1.0.1 and `temporal-utils` 1.0.3. Uses native `Temporal` when present. |
| `@js-temporal/polyfill` | 0.5.1 (2025-03-31) | ISC, engines `>=12`. The README still says "under construction"; it tracks the March 2025 spec. |
| `luxon` / `@types/luxon` | 3.7.2 / 3.7.5 | MIT, engines `>=12`. The `next` tag is `3.8.0-alpha.1`; ignore it. |
| `date-fns-tz` / `date-fns` | 3.2.0 (2024-09-30) / 4.4.0 | MIT; peer `date-fns ^3.0.0 \|\| ^4.0.0`. |
| `@tiptap/react`, `@tiptap/core`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/markdown`, `@tiptap/extension-table`, `@tiptap/extension-list` | 3.31.3 (2026-09-04) | MIT. `@tiptap/react` peers: `react`, `react-dom`, `@types/react` and `@types/react-dom` all `^17 \|\| ^18 \|\| ^19`, plus exact `@tiptap/core`/`@tiptap/pm` 3.31.3. `@tiptap/markdown` depends on `marked ^17.0.1`, and its docs label it "Beta". |
| `@milkdown/kit` | 7.22.1 (2026-08-12) | MIT. Its transformer depends on `remark ^15.0.1` / `unified ^11.0.3`. |
| `@milkdown/react` | 7.22.1 | MIT, peer `react: *`. Hard dependency on `@milkdown/crepe` 7.22.1, which pulls in `vue ^3.5`, `katex`, `dompurify`, CodeMirror and `lodash-es`. The runtime JS does not import them. |
| `codemirror` | 6.0.2 | MIT. Development moved from GitHub (`codemirror/dev` is archived) to code.haverbeke.berlin, and releases continue. |
| `@codemirror/view` / `@codemirror/state` / `@codemirror/lang-markdown` | 6.43.11 / 6.7.4 / 6.5.2 | MIT, ESM, no peers. |
| `@uiw/react-codemirror` | 4.25.11 | MIT; optional wrapper; peers `@codemirror/*`, `codemirror`, `@babel/runtime`, `react >=17`. |
| `uuid` | 14.0.2 (2026-08-18) | MIT, ESM only since v12 (loads from CJS through Node 24 `require(esm)`), bundled types. |
| `ulid` | 3.0.2 (2025-11-30) | MIT, ESM + CJS, bundled types. |
| `uuidv7` / `ulidx` | 1.2.1 / 2.4.1 | Apache-2.0 / MIT. Not needed. |
| Git | upstream 2.55.0 (2026-06-29); Trigger runtime 2.39.5 | Plumbing below verified on 2.39.5 and 2.50.1. `core.hooksPath=/dev/null` is documented only from 2.50.0, but works on 2.39.5 (tested). |
| `typescript` | 7.0.2 | Native (Go) compiler. Ships `lib.esnext.temporal.d.ts`. `typescript@6.0.3` used for comparison. |

pnpm 12 policy check: the default `minimumReleaseAge` is 1440 minutes since pnpm v11 (https://pnpm.io/settings#minimumreleaseage). Every version recommended here is more than one day old, including `@node-rs/argon2` 2.2.1 (5 days) and `temporal-polyfill` 1.0.5 (4 days), so none needs a `minimumReleaseAgeExclude` entry. Unlisted build scripts fail with `ERR_PNPM_IGNORED_BUILDS` (https://pnpm.io/settings#allowbuilds), so avoid `argon2`.

### TypeScript 7 compatibility (evidence)

- **Clean with `skipLibCheck: false` on TS 7.0.2:** `@types/node` 24 (`node:crypto`, `webcrypto`), `hash-wasm`, `@node-rs/argon2`, `argon2`, the whole unified/remark/rehype/mdast set, `minisearch`, `@orama/orama`, `temporal-polyfill`, `@js-temporal/polyfill`, `luxon` + `@types/luxon`, `date-fns-tz`, `uuid` and `ulid`. The check covered 665 files with 0 errors outside FlexSearch. Negative tests fail as expected, so the types are real and not `any`: `memoryCosts` in the root project, and a wrong `replaceRange` range, a wrong CodeMirror `changes` type and `contentTyp` in TipTap in the editor project.
- **CommonJS output (NestJS):** `module: nodenext`, `type: commonjs`, decorators on. `tsc` 7 emits `require("unified")`, `require("uuid")` and similar, and Node 24.15 runs the result. `require(esm)` is "no longer experimental" as of v24.15.0 (https://nodejs.org/docs/latest-v24.x/api/modules.html#loading-ecmascript-modules-using-require).
- **`@node-rs/argon2`:** `Algorithm.Argon2id` gives TS2748 "Cannot access ambient const enums when 'verbatimModuleSyntax' is enabled" on TS 7.0.2 and TS 6.0.3 alike. Omit `algorithm`, since the default is Argon2id.
- **`flexsearch` 0.8.212:** 4× TS2344 inside its own `index.d.ts`, identical on TS 6.0.3. This is a library typing bug, not a TS 7 problem; it needs `skipLibCheck: true`.
- **Editors (TipTap 3.31.3, Milkdown 7.22.1, CodeMirror 6):** the user code type-checks on TS 7. With `skipLibCheck: false` under pnpm's isolated `node_modules`, library `.d.ts` files report 18 errors: missing `prosemirror-model`, `@milkdown/utils`, `@babel/types` and `react` types that are imported but not declared as dependencies. TS 6.0.3 reports the same 18. With `skipLibCheck: true` both report 0. Next.js writes `skipLibCheck: true` into the app tsconfig; see the frontend research in this folder. **No package in this topic needs TypeScript 6 or 5.**

## Verified APIs

### 1. Argon2id

OWASP's recommended Argon2id settings, any one of which gives "an equal level of defense": `m=47104 (46 MiB), t=1, p=1`, `m=19456 (19 MiB), t=2, p=1`, `m=12288, t=3`, `m=9216, t=4`, `m=7168, t=5` (https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#argon2id). The same sheet says to raise work factors by re-hashing at the user's next authentication.

Server, zero dependencies (https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptoargon2algorithm-parameters-callback). `nonce` must be at least 8 bytes (16 random bytes recommended). `memory` is in KiB. `secret` is a pepper and `associatedData` is optional.

```ts
import { argon2, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
const argon2Async = promisify(argon2);
const salt = randomBytes(16);
const key = await argon2Async('argon2id', {
  message: passphrase, nonce: salt, memory: 19456, passes: 2, parallelism: 1, tagLength: 32,
}); // Buffer; store {v, alg:'argon2id', m, t, p, salt} next to the hash or wrapped key
```

Browser, the same output bytes (https://github.com/Daninet/hash-wasm):

```ts
import { argon2id, argon2Verify } from 'hash-wasm';
const bytes = await argon2id({ password, salt, memorySize: 19456, iterations: 2, parallelism: 1, hashLength: 32, outputType: 'binary' });
const phc = await argon2id({ password, salt, memorySize: 19456, iterations: 2, parallelism: 1, hashLength: 32, outputType: 'encoded' });
const ok = await argon2Verify({ password, hash: phc });
```

Optional server library with PHC strings and a rehash check (https://github.com/napi-rs/node-rs/tree/main/packages/argon2). The default is Argon2id with m=19456, t=2, p=1 and 32-byte output.

```ts
import { hash, verify, parseOptions } from '@node-rs/argon2';
const phc = await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 }); // $argon2id$v=19$m=19456,t=2,p=1$…
const ok = await verify(phc, password);
const needsRehash = parseOptions(phc).memoryCost < 19456;
```

Experiment results:
- **Identical output:** with the same salt and parameters, `node:crypto`, `@node-rs/argon2` `hashRaw`, `hash-wasm` (binary) and `argon2` (`raw: true`) produced byte-identical 32-byte output on macOS arm64 and on linux/amd64 glibc.
- **PHC interop:** `@node-rs`, `hash-wasm` and `argon2` each verify the others' PHC strings.
- **Median of 7 runs, macOS arm64** (it indicates relative speed only):

  | Parameters | `@node-rs` | `argon2` | `hash-wasm` | `node:crypto` |
  | --- | --- | --- | --- | --- |
  | m=19456, t=2 | 6.4 ms | 14.6 ms | 18.6 ms | 25.8 ms |
  | m=47104, t=1 | 8.3 ms | 20.2 ms | 24.9 ms | 37.5 ms |

- **Browser build of `@node-rs/argon2`:** `argon2.wasi-browser.js` creates `new WebAssembly.Memory({ initial: 4000, maximum: 65536, shared: true })`, which is a 256 MiB initial reservation. Shared memory needs cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` plus `Cross-Origin-Embedder-Policy: require-corp` or `credentialless`) (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements). `hash-wasm` has no such requirement.
- **CSP:** any in-browser WASM needs `script-src 'wasm-unsafe-eval'` (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src).
- **No WebCrypto Argon2 in browsers:** Node implements the WICG draft, but browser WebCrypto has no Argon2 (https://nodejs.org/docs/latest-v24.x/api/webcrypto.html#modern-algorithms-in-the-web-cryptography-api).

### 2. AES-256-GCM, HKDF and envelope encryption

What OWASP says:
- **Cipher modes:** "Where available, authenticated modes should always be used… GCM and CCM… should be used as a first preference" (https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html#cipher-modes).
- **Envelope encryption:** a DEK encrypts the data and a KEK encrypts the DEK. "The KEK must be stored separately from the DEK. The encrypted DEK can be stored with the data." A KDF over a passphrase can produce a KEK that wraps a random DEK, so a passphrase change does not re-encrypt data (https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html#encrypting-stored-keys).
- **Separation and rotation:** keep keys in a separate location from the data. Rotate on compromise, when the cryptoperiod ends, or at volume limits, and keep old keys for a period (same sheet, "Separation of Keys and Data" and "Key Lifetimes and Rotation").
- **One purpose per key:** "a single key should be used for only one purpose". Wrap keys "in such a manner that unauthorized modifications to the wrapping or to the associations will be detected", and apply integrity protection to stored keys (https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html).
- OWASP does not specify AAD encoding. The AAD design below is our way of meeting OWASP's "associations will be detected" requirement with GCM's AAD input.

AES-GCM parameters (https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams):
- **IV:** 96 bits, never reused with the same key.
- **`additionalData`:** authenticated but not encrypted, and the same bytes must be supplied to `decrypt()`.
- **`tagLength`:** defaults to 128.

Node AES-GCM (https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptocreatecipherivalgorithm-key-iv-options, https://nodejs.org/docs/latest-v24.x/api/crypto.html#deciphersetauthtagbuffer-encoding):
- `setAAD()` must be called before `update()`.
- `getAuthTag()` is called after `final()`.
- Set `authTagLength` on `createDecipheriv`, because short GCM tags are otherwise accepted (deprecated, DEP0182).

```ts
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Per-purpose, per-version KEK from the env master key (A4: CONTENT_KEK behind a key-provider interface)
const kek = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'symplist/content-kek/v1', 32));

function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}
function open(key: Uint8Array, box: { iv: Uint8Array; ct: Uint8Array; tag: Uint8Array }, aad: Uint8Array) {
  const d = createDecipheriv('aes-256-gcm', key, box.iv, { authTagLength: 16 });
  d.setAAD(aad);
  d.setAuthTag(box.tag); // throws "Invalid authentication tag length: 4" for a 4-byte tag
  return Buffer.concat([d.update(box.ct), d.final()]);
}
const dek = randomBytes(32);                                   // fresh per artifact
const wrapped = seal(kek, dek, aad('symplist.dek.v1', ctx));   // stored with the object
const body = seal(dek, bundleBytes, aad('symplist.bundle.v1', ctx));
```

HKDF (https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptohkdfdigest-ikm-salt-info-keylen-callback, https://developer.mozilla.org/en-US/docs/Web/API/HkdfParams):
- `info` is at most 1024 bytes in Node.
- `info` binds the derived key to a context, and salt need not be secret.

WebCrypto equivalent (browser Vault) (https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/wrapKey). The key being wrapped must be `extractable: true`, and AES-GCM is an allowed wrapping algorithm.

```ts
const wrappingKey = await crypto.subtle.importKey('raw', argon2Bytes, 'AES-GCM', false, ['wrapKey', 'unwrapKey']);
const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
const iv = crypto.getRandomValues(new Uint8Array(12));
const wrapped = await crypto.subtle.wrapKey('raw', dataKey, wrappingKey, { name: 'AES-GCM', iv, additionalData: aadBytes });
const dk = await crypto.subtle.unwrapKey('raw', wrapped, wrappingKey, { name: 'AES-GCM', iv, additionalData: aadBytes }, 'AES-GCM', false, ['decrypt']);
```

Experiment results:
- **Round trip:** an HKDF KEK wrapping a random DEK that encrypts a bundle round-trips correctly.
- **Tamper rejection:** a wrong AAD (a different task ID), a flipped ciphertext bit and a truncated 4-byte tag are all rejected.
- **Cross-platform:** WebCrypto `decrypt` accepts `node:crypto` output as `ct || tag`. WebCrypto HKDF `deriveBits` equals `hkdfSync`. `wrapKey`/`unwrapKey` under a key derived by Argon2id (hash-wasm) round-trips (48 bytes = 32-byte key + 16-byte tag).

### 3. Git plumbing for per-task bare repositories

Commands and documented behaviour:
- **`hash-object`:** `-w --stdin` writes a blob. Reading from stdin implies `--no-filters` unless `--path` is given (https://git-scm.com/docs/git-hash-object).
- **`mktree`:** reads `mode SP type SP oid TAB path` lines and sorts entries itself (https://git-scm.com/docs/git-mktree).
- **`commit-tree`:** `-p <parent>` may repeat and `-F -` reads the message from stdin. Identity and dates come from `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, and the date format `@<unix> <tz>` is accepted (https://git-scm.com/docs/git-commit-tree).
- **`update-ref`:** `<ref> <new> <old>` updates only if the current value equals `<old>`. An all-zero or empty `<old>` means "must not exist". `--stdin` `start/prepare/commit` is atomic (https://git-scm.com/docs/git-update-ref).
- **`bundle`:** `create <file> <rev-list-args>`. `verify` checks the format and prerequisites. `unbundle` feeds `index-pack` and prints the refs; it is "really plumbing, intended to be called only by git fetch". The default format is "the oldest supported format, based on the hash algorithm in use" (v2 for SHA-1) (https://git-scm.com/docs/git-bundle).
- **`diff`:** `--no-ext-diff` disallows external diff drivers. `--no-textconv` disables textconv filters, which are on by default for `diff` and `log`. Useful extras: `--no-renames`, `--diff-algorithm=histogram`, `-U<n>`, `--numstat`, `-z` (https://git-scm.com/docs/git-diff).
- **`log`:** placeholders `%H %P %an %ae %aI %cI %B %x00`, with `-z` to separate records with NUL (https://git-scm.com/docs/pretty-formats).

Environment isolation (https://git-scm.com/docs/git#_environment_variables, https://git-scm.com/docs/git-config):
- `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` "can be set to `/dev/null` to skip reading configuration files of the respective level". `GIT_CONFIG_NOSYSTEM` skips `/etc/gitconfig`.
- `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` add "command"-scope config, which counts as protected configuration (so `safe.bareRepository` is honoured).
- `core.hooksPath`: "You can also disable all hooks entirely by setting `core.hooksPath` to `/dev/null`". Documented since 2.50.0; also works on 2.39.5. `update-ref` otherwise runs the `reference-transaction` hook.
- `protocol.allow=never` blocks every transport for clone, fetch and push. `GIT_PROTOCOL_FROM_USER=0` and `GIT_TERMINAL_PROMPT=0` are also set.
- `safe.bareRepository=explicit` makes Git "only work with bare repositories specified via… `--git-dir`… or the `GIT_DIR` environment variable".
- `GIT_ATTR_NOSYSTEM` is not documented, but `attr.c` in v2.55.0 reads it (`git_attr_system_is_enabled`). Also set `core.attributesFile=/dev/null`.

Exact commands validated end to end (`scratchpad/research/core-libs/git/git-experiment.sh`; all checks passed on Git 2.50.1 macOS and Git 2.39.5 in the Trigger `node-24` image):

```bash
# Every git call runs as:
env -i PATH=/usr/bin:/bin HOME="$TMP/home" LC_ALL=C TZ=UTC GIT_DIR="$REPO" \
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_SYSTEM=/dev/null GIT_CONFIG_GLOBAL=/dev/null \
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false GIT_PROTOCOL_FROM_USER=0 \
  GIT_NO_REPLACE_OBJECTS=1 GIT_ATTR_NOSYSTEM=1 GIT_ADVICE=0 GIT_PAGER=cat \
  GIT_CONFIG_COUNT=11 \
  GIT_CONFIG_KEY_0=core.hooksPath        GIT_CONFIG_VALUE_0=/dev/null \
  GIT_CONFIG_KEY_1=protocol.allow        GIT_CONFIG_VALUE_1=never \
  GIT_CONFIG_KEY_2=core.attributesFile   GIT_CONFIG_VALUE_2=/dev/null \
  GIT_CONFIG_KEY_3=commit.gpgSign        GIT_CONFIG_VALUE_3=false \
  GIT_CONFIG_KEY_4=gc.auto               GIT_CONFIG_VALUE_4=0 \
  GIT_CONFIG_KEY_5=maintenance.auto      GIT_CONFIG_VALUE_5=false \
  GIT_CONFIG_KEY_6=core.fsmonitor        GIT_CONFIG_VALUE_6=false \
  GIT_CONFIG_KEY_7=safe.bareRepository   GIT_CONFIG_VALUE_7=explicit \
  GIT_CONFIG_KEY_8=transfer.fsckObjects  GIT_CONFIG_VALUE_8=true \
  GIT_CONFIG_KEY_9=core.logAllRefUpdates GIT_CONFIG_VALUE_9=false \
  GIT_CONFIG_KEY_10=init.defaultBranch   GIT_CONFIG_VALUE_10=main \
  [GIT_AUTHOR_NAME=… GIT_AUTHOR_EMAIL=… GIT_AUTHOR_DATE='@1757894400 +0000' GIT_COMMITTER_NAME=… GIT_COMMITTER_EMAIL=… GIT_COMMITTER_DATE='@1757894400 +0000'] \
  /usr/bin/git <args>

git init --bare --quiet --template= --initial-branch=main "$REPO"          # no sample hooks copied
B=$(printf '%s' "$MARKDOWN" | git hash-object -w --stdin)
T=$(printf '100644 blob %s\tdocument.md\n' "$B" | git mktree)
C1=$(printf 'Create document\n\nSymplist-Request: req_1\n' | git commit-tree "$T" -F -)
git update-ref -m create refs/heads/main "$C1" 0000000000000000000000000000000000000000
C2=$(printf 'Update Budget section\n' | git commit-tree "$T2" -p "$C1" -F -)
git update-ref -m update refs/heads/main "$C2" "$C1"                        # CAS
git bundle create --quiet doc.bundle refs/heads/main                        # self-contained
# restore into a new private temp dir
git init --bare --quiet --template= --initial-branch=main "$RESTORE"
git bundle verify doc.bundle        # "…is okay" / "The bundle records a complete history." / "hash algorithm: sha1"
git bundle list-heads doc.bundle
git bundle unbundle doc.bundle      # prints "<oid> refs/heads/main"; objects only, no ref written
git update-ref refs/heads/main "$OID" 0000000000000000000000000000000000000000
git fsck --strict --no-dangling --no-progress
git diff --no-ext-diff --no-textconv --no-color --no-renames --diff-algorithm=histogram -U3 "$C1" "$C2" -- document.md
git diff --no-ext-diff --no-textconv --numstat -z "$C1" "$C2" -- document.md
git cat-file blob "$C1:document.md"
git log -z --no-color --format='%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%B' refs/heads/main
git rev-list --count refs/heads/main
# restore = new commit with the old tree and the current head as parent
T_OLD=$(git rev-parse --verify "$C1^{tree}"); C3=$(printf 'Restore %s\n' "$C1" | git commit-tree "$T_OLD" -p "$C2" -F -)
git update-ref refs/heads/main "$C3" "$C2"
```

Observed:
- **CAS failures:**
  - Create-only on an existing ref fails with `cannot lock ref 'refs/heads/main': reference already exists` (exit 128).
  - A stale compare-and-swap fails with `is at <C2> but expected <C1>`, and the head does not move.
- **Hooks and config isolation:**
  - A planted executable `hooks/reference-transaction` never ran. Control: without `core.hooksPath=/dev/null` it ran.
  - `diff.external=/bin/false` written into the repo's own config was ignored because of `--no-ext-diff`. Control: without the flag, `git diff` exits 128.
- **Fetch is blocked:** `git fetch <file.bundle>` and `git fetch file://…` both fail with `fatal: transport 'file' not allowed` under `protocol.allow=never`. Restore therefore uses `bundle unbundle` + `update-ref`, which needs no transport.
- **Deterministic IDs:** with fixed `GIT_*_DATE` values, commit IDs are the same on 2.39.5 and 2.50.1 (`36e11ece…`, `c070bc19…`).
- **Portable bundles:** the 685-byte bundles written by each version are byte-identical, and each version restores the other's.
- **Integrity checks:**
  - A bundle with one corrupted byte is rejected by `unbundle` (`pack has bad object… index-pack died`).
  - An incremental bundle (`C2..main`) passes `verify` only where the prerequisite exists ("Repository lacks these prerequisite commits").
  - The restore commit's net diff against `C1` is empty (`--exit-code` 0).

### 4. Markdown parsing and safe HTML

Positions and sections (https://github.com/syntax-tree/mdast-util-from-markdown, https://github.com/syntax-tree/unist#position):
- Nodes carry `position.start/end` with 1-based `line`/`column` and 0-based `offset`.
- Generated nodes have no position.
- `offset` is a JS string (UTF-16) index; verified with emoji and `é`.

```ts
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { toString } from 'mdast-util-to-string';
const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
const headings = tree.children.filter((n): n is import('mdast').Heading => n.type === 'heading');
// section i: start = headings[i].position.start.offset; own body ends at the next heading;
// subtree ends at the next heading with depth <= headings[i].depth; text before the first heading = preamble
```

Verified:
- A `# not a heading` line inside a fenced code block is not a heading.
- Duplicate `## Budget` headings get distinct sections, setext headings are detected, and the preamble is addressable.
- Replacing one section by offsets leaves the others byte-identical.

Safe server-rendered HTML (https://github.com/remarkjs/remark-rehype#options, https://github.com/rehypejs/rehype-sanitize, https://github.com/remarkjs/remark-gfm):
- `allowDangerousHtml` defaults to `false`, so raw HTML is dropped.
- `rehype-sanitize`: "use `rehype-sanitize` after the last unsafe thing".
- `defaultSchema` follows GitHub. It prefixes `id`/`name` with `user-content-`, and `href` protocols are limited to `http, https, irc, ircs, mailto, xmpp`.

```ts
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
const html = String(await unified()
  .use(remarkParse).use(remarkGfm)
  .use(remarkRehype)                                            // raw HTML dropped; footnote ids already prefixed
  .use(rehypeSanitize, { ...defaultSchema, clobberPrefix: '' }) // last transform; avoids double prefix
  .use(rehypeStringify)
  .process(markdown));
```

Verified against a hostile sample:
- `<script>`, `<img onerror>`, `<iframe>`, `<details>` and `onclick` are removed, and `[x](javascript:…)` becomes `<a>x</a>`. Task lists and tables render.
- With both default prefixes, footnote ids become `user-content-user-content-fn-n` while hrefs point to `#user-content-fn-n`, which breaks the anchors. `clobberPrefix: ''` in the sanitizer fixes this, and is safe only because raw HTML is already dropped upstream.

Canonical serialization (https://github.com/syntax-tree/mdast-util-to-markdown#options): the defaults are `bullet '*'`, `emphasis '*'`, `strong '*'`, `rule '*'`, `listItemIndent 'one'` and `fences true`. `remark-stringify` with `{ bullet: '*', emphasis: '*', strong: '_', rule: '-', fences: true, listItemIndent: 'one' }` reproduced Milkdown 7.22.1's output byte for byte on the test document, so it was a fixed point.

### 5. Search

MiniSearch (https://lucaong.github.io/minisearch/classes/MiniSearch.MiniSearch.html, https://github.com/lucaong/minisearch):
- **Options:** `fields`, `storeFields`, `idField`, `extractField`, `tokenize` and `processTerm`. A falsy return from `processTerm` drops the term.
- **Search:** `search(q, { prefix, fuzzy, boost, combineWith, filter, fields })`.
- **Updates:** `add`/`addAll`/`remove`/`discard`/`replace`/`vacuum`.
- **Serialization:** `JSON.stringify(ms)` and `MiniSearch.loadJSON(json, options)` / `loadJSONAsync`. `loadJSON` "should be given the same options".
- **Tokenizer:** the default splits on Unicode space and punctuation.

```ts
import MiniSearch from 'minisearch';
const seg = new Intl.Segmenter(undefined, { granularity: 'word' });
const norm = (s: string) => s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
const options = {
  fields: ['title', 'heading', 'body'], storeFields: ['taskId'],
  tokenize: (t: string) => [...seg.segment(t)].filter((s) => s.isWordLike).map((s) => s.segment),
  processTerm: norm,
  searchOptions: { boost: { title: 3, heading: 2 }, prefix: true, fuzzy: 0.2 },
};
const ms = new MiniSearch(options); ms.addAll(docs);
const blob = JSON.stringify(ms);                 // encrypt → R2
const again = MiniSearch.loadJSON(blob, options); // identical options required
```

`Intl.Segmenter` segments expose `isWordLike` only for `granularity: "word"` (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter/segment). With it, a CJK mid-sentence query (`行きます`) matches; with the default tokenizer it does not.

Benchmark: 5,001 section documents, 5.5 MB JSON, 20k-word skewed vocabulary plus Latin, Turkish, German, Cyrillic, Greek, Devanagari, CJK and emoji. Node 24.15 on macOS arm64 with `--expose-gc`, all using the same NFKD normalizer.

| Library | Build | Heap after build | Serialized (gzip) | Load | Avg query | Unicode results |
| --- | --- | --- | --- | --- | --- | --- |
| MiniSearch 7.2.0 | 424 ms | +33.9 MB | 5.7 MB (1.4 MB) | 87 ms | 1.4 ms | `CAFÉ`=`cafe`, `istanbul`→`İstanbul`, fullwidth and `ﬁ` ligature match; fuzzy `budgat`→`budget` works |
| FlexSearch 0.8.212 | 786 ms | +49.5 MB | 33.4 MB (3.9 MB) | 124 ms | 0.1 ms | normalization works via `encoder.normalize`; `suggest` is not edit-distance fuzzy (`budgat` = 0); multi-key async `export`/`import` |
| Orama 3.1.18 | 537 ms | +100.6 MB | 31.4 MB (7.7 MB) | 232 ms | 2.4 ms | default English splitter `/[^A-Za-zàèéìòóù0-9_'-]+/` drops CJK (`東京` = 0), `İstanbul` and the `ﬁ` ligature fail; `tolerance` fuzzy works |

Orama: `create({schema})`, `insertMultiple`, `search({term, properties, tolerance, exact, boost, threshold})` (https://docs.orama.com/docs/orama-js), plus `save`/`load` exported from `@orama/orama`. FlexSearch: `Document`, `Charset` presets, and async `export(handler)`/`import(key, data)` (https://github.com/nextapps-de/flexsearch). Both are Apache-2.0.

### 6. Dates, time zones and DST

Status:
- **Standard:** Temporal reached TC39 Stage 4 in March 2026 (https://www.igalia.com/2026/03/13/Temporal-Reaches-Stage-4.html).
- **Node 26:** "The Temporal API is now enabled by default in Node.js 26" (https://nodejs.org/en/blog/release/v26.0.0).
- **Node 24:** `typeof Temporal === 'undefined'` on Node 24.15.0; V8 13.6 has only `--harmony-temporal` "(in progress / experimental)". Do not use it.
- **Browsers:** `@mdn/browser-compat-data` 8.1.1 lists Chrome/Edge 144, Firefox 139, Safari "preview" only, Safari iOS none, Node 26.0.0. A polyfill is required on both Node 24 and the web.

temporal-polyfill (https://github.com/fullcalendar/temporal-polyfill):
- **Entry points:** `import { Temporal } from 'temporal-polyfill'` is a side-effect-free ponyfill that "Uses native if available". `temporal-polyfill/global` installs a global polyfill.
- **TS ≥ 6 globals:** add `"lib": ["esnext"]` (or `esnext.temporal`). TS 7.0.2 ships `lib.esnext.temporal.d.ts`.
- **Spec compliance:** "near-perfect with just 2 intentional deviations". It is 19.4 kB min+gzip against 52.1 kB for `@js-temporal/polyfill`, and has CI on Node 16 through 26.

Disambiguation (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/PlainDateTime/toZonedDateTime, https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Temporal/ZonedDateTime/from): `"compatible"` (the default) takes the later time for gaps and the earlier time for overlaps. `"earlier"` and `"later"` force one side, and `"reject"` throws `RangeError`.

```ts
import { Temporal } from 'temporal-polyfill';
type Resolution = { kind: 'ok'; zoned: string } | { kind: 'gap'; suggestion: string } | { kind: 'overlap'; earlier: string; later: string };
function resolveLocal(date: string, time: string, timeZone: string): Resolution {
  const pdt = Temporal.PlainDateTime.from(`${date}T${time}`);
  const e = pdt.toZonedDateTime(timeZone, { disambiguation: 'earlier' });
  const l = pdt.toZonedDateTime(timeZone, { disambiguation: 'later' });
  if (e.epochNanoseconds === l.epochNanoseconds) return { kind: 'ok', zoned: e.toString() };
  if (e.toPlainDateTime().equals(pdt) && l.toPlainDateTime().equals(pdt)) return { kind: 'overlap', earlier: e.toString(), later: l.toString() };
  return { kind: 'gap', suggestion: l.toString() }; // "propose the next valid time"
}
// date-only: overdue at start of the next local day (handles zones that skip midnight)
const overdueAt = Temporal.PlainDate.from('2026-03-07').add({ days: 1 }).toZonedDateTime({ timeZone: 'America/New_York' }).toInstant();
// timed: store { instant, local, timeZone }
```

Observed with temporal-polyfill 1.0.5:
- **Gaps:**
  - New York 2026-03-08 02:30 → gap, suggestion `03:30-04:00`.
  - London 2026-03-29 01:30 → gap, suggestion `02:30+01:00`.
  - Lord Howe 2026-10-04 02:15 → 30-minute gap, suggestion `02:45+11:00`.
- **Overlap:** New York 2026-11-01 01:30 → overlap, `-04:00` / `-05:00`.
- **No DST:** Kolkata `+05:30` and Kathmandu `+05:45` resolve to a single time.
- **`reject`:** throws `RangeError: Ambiguous offset`.
- **Start of day:** Havana 2026-03-08 → `01:00-04:00`, because midnight does not exist that day.
- **Reminder arithmetic:**
  - "Previous day at 09:00" → `2026-03-07T09:00-05:00`.
  - "1 hour before" → `11:00-04:00`.
  - "24 hours before" → `2026-03-07T11:00-05:00`.
- **Reference polyfill:** `@js-temporal/polyfill` 0.5.1 agrees on the overlap case.

Alternatives, observed:
- **Luxon:** a gap silently moves forward (`03:30-04:00`). For overlaps "Luxon's behavior here is undefined" (https://moment.github.io/luxon/#/zones?id=dst-weirdness), and the only detection path is `DateTime#getPossibleOffsets()` (https://moment.github.io/luxon/api-docs/index.html#datetimegetpossibleoffsets).
- **date-fns-tz:** `fromZonedTime('2026-03-08 02:30', 'America/New_York')` returned `06:30Z`, which is 01:30 EST, i.e. moved backwards, with no ambiguity signal (https://github.com/marnusw/date-fns-tz).

### 7. Page editor (React 19)

Requirement (design brief `design/mockups/task_document.md`): the page should feel like a document, with a small formatting toolbar and a discoverable raw Markdown view. Switching views preserves content and position, and Simon updates named sections.

- **TipTap 3.31.3:**
  - **Markdown:** `@tiptap/markdown` (docs: "Beta… a early release and can be subject to change or may have edge cases"). Built on MarkedJS. API: `contentType: 'markdown'`, `editor.getMarkdown()`, `editor.markdown.parse/serialize`, and `Markdown.configure({ indentation, markedOptions })` (https://tiptap.dev/docs/editor/markdown, https://tiptap.dev/docs/editor/markdown/getting-started/installation).
  - **React:** `useEditor({ …, immediatelyRender: false })` for SSR (https://tiptap.dev/docs/editor/getting-started/install/react).
  - **Licence:** the open-source packages are MIT; comments, AI and similar are paid Pro extensions (https://tiptap.dev/docs/editor/getting-started/overview).
  - **Section replacement:** `insertContentAt({ from, to }, md, { contentType: 'markdown' })` is typed in `@tiptap/markdown`'s `.d.ts`.
- **Milkdown 7.22.1:**
  - **Engine:** ProseMirror with a remark transformer.
  - **Macros:** `getMarkdown(range?)`, `replaceAll(md, flush?)`, `replaceRange(md, {from, to})`, `insert`, `insertPos`, `outline` (https://milkdown.dev/docs/api/utils).
  - **Change events:** `listenerCtx.markdownUpdated((ctx, markdown, prevMarkdown) => …)` (https://milkdown.dev/docs/api/plugin-listener).
  - **React:** `MilkdownProvider`, `Milkdown`, `useEditor(getEditor)`. Signatures come from the published `.d.ts`, because the React recipe page did not render.
- **CodeMirror 6:**
  - **Changes:** `view.dispatch({ changes: { from, to, insert } })`. Positions are UTF-16 offsets in the original document, and `tr.changes.mapPos()` maps positions (https://codemirror.net/docs/guide/).
  - **Markdown:** `markdown()` from `@codemirror/lang-markdown`.
  - **Licence and hosting:** "open source under a permissive license (MIT)", developed on code.haverbeke.berlin (https://codemirror.net/).

Round-trip experiment (jsdom, each editor headless). Test document: headings, `*` lists, `1)` lists, task list, blockquote, aligned table, fenced code, duplicate heading, inline `<br>`, setext heading, autolink literal, footnote.

| Editor | Lines changed on first load → serialize | Second pass | Notable changes |
| --- | --- | --- | --- |
| TipTap + `@tiptap/markdown` | 23 | stable | Footnotes corrupted to `\[^1\]`; `<br>` + newline split into a new paragraph; `__strong__`→`**strong**`; `*`→`-`; `1)`→`1.`; setext→ATX; autolink→`[url](url)`; extra blank lines around the table; trailing newline removed |
| Milkdown (commonmark + gfm) | 14 | stable | Inline `<br>` dropped; `-` task items→`*`; `1)`→`1.`; nested indent 4→2; table delimiter normalized; setext→ATX; autolink→`<url>`; footnotes kept |
| CodeMirror 6 | 0 (lossless; only the intended section replacement) | n/a | Replacement by string offsets from mdast |

Section replacement by ProseMirror top-level positions ("nth heading titled X up to the next heading of equal or lower depth") worked in both TipTap (`insertContentAt`) and Milkdown (`replaceRange`), and left the rest of the normalized document unchanged.

```tsx
// Milkdown page view (types checked on TS 7 + React 19.3)
const { get } = useEditor((root) => Editor.make()
  .config((ctx) => {
    ctx.set(rootCtx, root);
    ctx.set(defaultValueCtx, value);
    ctx.get(listenerCtx).markdownUpdated((_c, md, prev) => { if (md !== prev) onChange(md); });
  })
  .use(commonmark).use(gfm).use(history).use(listener), []);
// server-published doc (e.g. Simon edited a section) → editor
useEffect(() => { const ed = get(); if (ed && ed.action(getMarkdown()) !== value) ed.action(replaceAll(value)); }, [get, value]);

// Raw view
view.dispatch({ changes: { from: section.start, to: section.bodyEnd, insert: newSectionMarkdown } });
```

### 8. IDs

- **`uuid` 14 `v7([options[, buffer[, offset]]])`:** options `msecs`, `seq`, `random`/`rng`. v12+ is ESM only (https://github.com/uuidjs/uuid#uuidv7options-buffer-offset). Without options it keeps internal state (`seq + 1` within the same millisecond). 100,000 in-process IDs were strictly increasing.
- **`ulid` 3 `monotonicFactory()`:** strict ordering within a millisecond by incrementing the random part; `decodeTime` and `isValid` are available (https://github.com/ulid/javascript). 100,000 IDs were strictly increasing.
- **RFC 9562:** UUIDv7 is a 48-bit Unix-ms timestamp plus version, variant and random/counter bits. Implementations "MUST NOT assume that UUIDs are hard to guess" and must not use them as capabilities (https://www.rfc-editor.org/rfc/rfc9562.html#name-uuid-version-7, https://www.rfc-editor.org/rfc/rfc9562.html#name-security-considerations).
- **`crypto.randomUUID()`:** v4 only. OWASP lists it as a secure generator alongside `randomBytes` (https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html).

## Decisions and recommendations

1. **Argon2id.**
   - **Server:** `node:crypto.argon2` (Node ≥ 24.7; verified on 24.15, 24.18 and 24.21), with OWASP `m=19456, t=2, p=1`, a 16-byte random salt and 32-byte output. No npm dependency and no build script.
   - **Stored format:** a versioned record `{v, alg, m, t, p, salt, hash}` rather than a PHC string. Compare with `timingSafeEqual`, and re-hash on login when the parameters change.
   - **Startup check:** fail fast when `typeof crypto.argon2 !== 'function'`, for self-hosters on Node builds using shared OpenSSL older than 3.2.
   - **Browser (Vault unlock):** `hash-wasm` 4.12.0. Its output is byte-identical to the server's, it needs no COOP/COEP headers, and CSP needs `'wasm-unsafe-eval'`.
   - **Fallback:** `@node-rs/argon2` 2.2.1 on the server only, if throughput or PHC strings become important. It was about 4× faster in this test. Omit `algorithm` because of the const-enum issue.
   - **Avoid:** `argon2`, which needs a build-script approval and is Node only; the `@node-rs/argon2` browser build, which needs shared memory, cross-origin isolation, a 256 MiB initial memory reservation and alpha `@emnapi` dependencies; and WebCrypto Argon2, which browsers do not support.
2. **Envelope encryption.**
   - **Cipher and randomness:** AES-256-GCM through `node:crypto` on the server and `crypto.subtle` in the browser. 32-byte random DEK per object (bundle, index artifact, snapshot, Vault); 12-byte random IV per encryption; 16-byte tag, always passing `authTagLength: 16` to `createDecipheriv`.
   - **KEK:** derive a per-purpose, per-version KEK with HKDF-SHA-256 from the env master key (`CONTENT_KEK`, `VAULT_RECOVERY_KEY`), for example `info = "symplist/content-kek/v1"`. This follows OWASP's one-purpose-per-key rule. The Vault's user KEK is Argon2id(passphrase, salt), and the recovery KEK wraps a second copy of the same DEK.
   - **AAD:** bind the context in both layers with a canonical, length-safe encoding, for example deterministic JSON or length-prefixed fields: `fmt`, `owner`, `task`/`repo`, `artifactId`, `kekVersion`, and for Vault `kdf`, `m`, `t`, `p`. The DEK wrap and the payload use different `fmt` labels.
   - **Stored envelope:** `{fmt, kekVersion, wrapIv, wrappedDek, wrapTag, iv, tag}` with the ciphertext. Keys never go into D1 or R2.
   - **Rotation:** re-wrap DEKs, never re-encrypt bulk data, and keep retired KEK versions for decryption.
3. **Git.**
   - **Process:** use Git CLI plumbing exactly as validated above, through `execFile` with fixed argument arrays and `env` replaced entirely, not merged with `process.env`.
   - **Workspace:** a fresh `mkdtemp` directory per operation.
   - **Restore:** `bundle verify` → `bundle unbundle` → `update-ref <ref> <oid> <zero>` → `fsck --strict`. Do not use `fetch` or `clone`, which keeps `protocol.allow=never` absolute.
   - **Storage:** keep SHA-1, v2, full self-contained bundles of `refs/heads/main`. They were byte-identical across Git 2.39.5 and 2.50.1.
   - **Render image:** pin Debian bookworm with apt `git` to match Trigger's Git 2.39.5, or test both versions in CI.
   - **Author identity:** pass explicit author and committer dates from the server clock so retries produce the same commit ID.
   - **Local compare-and-swap:** use `update-ref <new> <old>`. D1 remains the publication authority.
4. **Markdown.** Use the unified 11 family.
   - **Structure (server and Simon tools):** `mdast-util-from-markdown` + GFM for section splitting by `position.offset`.
   - **Server HTML:** `remark-parse → remark-gfm → remark-rehype (no allowDangerousHtml) → rehype-sanitize → rehype-stringify` for artifact pages and email-safe HTML.
   - **Footnote anchors:** set `clobberPrefix: ''` on the sanitizer only, or rewrite hashes as GitHub does.
   - **Never add** `rehype-raw` or `allowDangerousHtml`.
   - **Canonical Markdown:** use one shared `remark-stringify` options object (`{ bullet: '*', emphasis: '*', strong: '_', rule: '-', fences: true, listItemIndent: 'one' }`) wherever the server must serialize.
5. **Search:** MiniSearch 7.2.0 (MIT).
   - **Why:** smallest memory and serialized size in the benchmark, a single-string JSON format, prefix and edit-distance fuzzy search, and full control over tokenizing and normalizing. It works in Node and browsers.
   - **Normalization:** NFKD, strip `\p{M}`, lowercase, and tokenize with `Intl.Segmenter`.
   - **Artifact:** encrypt the JSON per user and version the options (store `indexFormatVersion`), because `loadJSON` needs identical options.
   - **Not chosen:** FlexSearch (typing bug, 6× larger dump, no real fuzzy search, Apache-2.0) and Orama (English splitter drops non-Latin scripts, 3× the heap, Apache-2.0).
6. **Time:** `temporal-polyfill` 1.0.5 ponyfill (`import { Temporal } from 'temporal-polyfill'`) in shared code for Nest, Trigger and Next.
   - **Date-only deadlines:** `PlainDate` + IANA zone.
   - **Timed deadlines:** store `{ instant, local PlainDateTime, timeZone }`.
   - **Save flow:** detect gaps and overlaps with `earlier`/`later` comparison before saving. "Previous day at 9" uses calendar arithmetic; "one hour before" uses exact arithmetic.
   - **Zone validation:** validate by constructing, for example with a try/catch around `Temporal.Now.zonedDateTimeISO(zone)`, and store the resolved `timeZoneId`. Verified: `asia/kolkata` → `Asia/Kolkata`, `Asia/Calcutta` is kept as given, and `Mars/Olympus` throws `RangeError`. Do not validate against `Intl.supportedValuesOf('timeZone')`. MDN says engines following Temporal return only primary identifiers (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/supportedValuesOf), yet Node 24.15 still lists `Asia/Calcutta`, so the list differs by engine. Use it only for the picker.
   - **Later:** drop the polyfill on Node 26 LTS once Safari ships Temporal, since it already defers to native.
   - **Not chosen:** Luxon (undefined overlap behaviour) and date-fns-tz (silent backward gap shift, no ambiguity signal, last release 2024).
7. **Editor:** a Markdown string is the source of truth.
   - **Raw view:** CodeMirror 6 (`@codemirror/view` 6.43.11, `@codemirror/state` 6.7.4, `@codemirror/lang-markdown` 6.5.2), used directly or through the optional `@uiw/react-codemirror`. It is lossless, and section replacement uses the same mdast offsets as the server.
   - **Page view:** Milkdown `@milkdown/kit` 7.22.1 (MIT). Its serializer is remark, so a server `remark-stringify` with the options in item 4 is a fixed point of its output; it kept footnotes; and `replaceRange`/`replaceAll` cover Simon's section updates.
   - **Milkdown React integration:** mount it directly with a ref and `Editor.make()`, or through `@milkdown/react`, accepting its install-time `@milkdown/crepe`/Vue dependency.
   - **Normalization commits:** the first page-view edit normalizes list markers, setext headings and similar, so show or commit that as one normalization change rather than surprising the user.
   - **TipTap:** the fallback if Milkdown blocks a UX requirement. It is not preferred now: its Markdown extension is labelled Beta, it corrupted footnotes and restructured `<br>` in the test, and it parses with `marked` rather than the server's micromark.
   - **Licences:** install only the MIT `@tiptap/*` packages and no Pro registry.
8. **IDs:** `uuid` 14.0.2 `v7()` for database primary keys and opaque object names that benefit from time ordering (tasks, revisions, runs, R2 artifact IDs). Use `crypto.randomBytes(32)` for share tokens, OTP nonces and anything that authorizes access (RFC 9562 and spec note 16), never UUIDs. Skip ULID, which adds a second format with no benefit here.

## Risks and open questions

- **Stale browser Argon2 library.** `hash-wasm`'s last release was November 2024. Its output matched three other implementations here. Pin it, and keep a known-answer test (the RFC 9106 vectors plus our own server-generated vectors) in CI so a replacement can be swapped in.
- **Argon2id parameters in the browser.** Vault unlock on low-end phones with m=19 MiB, t=2 is not measured. Store parameters per Vault so they can change later; the OWASP alternatives trade memory for iterations.
- **Node's native `crypto.argon2`.** It is about 4× slower than `@node-rs` in this test. It is expected to share libuv's 4-thread default pool, like `pbkdf2`/`scrypt`, but the Node docs do not list argon2 there (https://nodejs.org/docs/latest-v24.x/api/cli.html#uv_threadpool_sizesize). Load-test concurrent verifies, such as artifact password attempts, and rate-limit them. Revisit `@node-rs/argon2` if p95 suffers.
- **AAD encoding.** It must be canonical and versioned. Any change breaks decryption of old objects, so freeze the encoder and test vectors before the first write.
- **Git on Trigger.** The runtime image has Git 2.39.5 (Debian bookworm), which predates the documented `core.hooksPath=/dev/null` (2.50) and the config-based hooks of Git 2.54 and later. Isolation relies on both working; the controls here showed they do on 2.39.5. Re-run `git-experiment.sh` in CI on every image bump.
- **Undocumented `GIT_ATTR_NOSYSTEM`.** It is honoured in source but not documented. `core.attributesFile=/dev/null` is documented; system attributes may still apply without the variable.
- **Full bundles grow with history.** Size limits and incremental bundles are still open (spec note 11). Incremental `verify` requires the prerequisite commits in the restore repository.
- **Editor position mapping.** "Switching views preserves position" needs a mapping from ProseMirror position to Markdown offset. Section-level mapping (heading index) is feasible; character-exact mapping is not provided by any of the three editors.
- **Milkdown.** It depends on one primary maintainer, has a heavy `@milkdown/react` dependency tree, and inline HTML is dropped on edit. Decide whether that loss is acceptable or should warn.
- **TipTap Markdown.** Re-evaluate it once it leaves Beta.
- **Search quality.** `ß`→`ss` folding is not handled by NFKD plus lowercase (`strasse` did not match `Straße`). Decide on locale folding. Benchmark with the real beta corpus, and measure encrypted-index cold load (decrypt, JSON.parse, `loadJSON`) against the 300 ms warm target.
- **`skipLibCheck`.** TipTap, Milkdown and FlexSearch `.d.ts` files need `skipLibCheck: true` under pnpm's isolated `node_modules`. The same happens on TS 6.0.3. Alternatively, add explicit dev deps (`prosemirror-model`, `@types/react`) to satisfy the phantom imports.
- **Temporal polyfill on Node 24.** It stays on Node 24 until the Node 26 LTS migration, and native Temporal must not be mixed with polyfill objects across realms. Always import the ponyfill in shared code rather than relying on `globalThis.Temporal`.
- **ID order.** UUIDv7 is strictly monotonic only within one process. Across Nest and Trigger instances, IDs created in the same millisecond order randomly, so never rely on ID order for correctness; use D1 sequence or generation columns.
