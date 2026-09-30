/**
 * The app's one secret mechanism: Electron's `safeStorage`, which on macOS is a key held in the login
 * Keychain, wrapping values written to files under `userData`.
 *
 * Two secrets live here — the cloud session cookie and the MCP grant key dsh authenticates with — and
 * the model provider key will be the third. They share this store deliberately: one mechanism to reason
 * about, one place a reviewer checks, and no second code path that could end up writing plaintext.
 *
 * **There is no plaintext fallback.** When `safeStorage.isEncryptionAvailable()` is false, every write
 * is refused and every read answers nothing, so the app signs in again on each launch. That is a worse
 * experience than a file, and it is the right one: a session cookie in a readable file is a credential
 * any other process on the machine can lift.
 *
 * **Nothing here may be called before `app.whenReady()`.** Measured on Electron 44 / macOS:
 * `isEncryptionAvailable()` answers `false` before ready and `true` after, so a store consulted too
 * early reports "no encryption on this machine" and quietly stops persisting. `assertReady` below is
 * the guard; `index.ts` constructs the store inside `start()`, which runs after `whenReady`.
 *
 * Electron is injected rather than imported, so these tests run under plain Node with a fake.
 */
import { dirname, join } from "node:path";
import type { MainLog } from "../log.ts";

/** The part of Electron's `safeStorage` this store uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** The filesystem calls this store makes, injected so the tests need no temp directory. */
export interface SecretFileSystem {
  readFileSync(path: string): Buffer;
  writeFileSync(path: string, data: Buffer, options: { readonly mode: number }): void;
  mkdirSync(path: string, options: { readonly recursive: true; readonly mode: number }): void;
  chmodSync(path: string, mode: number): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { readonly force: true }): void;
}

export interface SecretStoreOptions {
  /** `app.getPath("userData")`. One directory per installed app, per user. */
  readonly userDataPath: string;
  readonly safeStorage: SafeStorageLike;
  readonly log: MainLog;
  readonly fs: SecretFileSystem;
  /** False until `app.whenReady()` has resolved; see the module comment. */
  readonly isReady: () => boolean;
}

/** Owner read and write only. Set on the temp file before the rename, so the final name is never laxer. */
const SECRET_FILE_MODE = 0o600;
/** The directory holding the encrypted files. Owner-only, so a listing does not even name the secrets. */
const SECRET_DIR_MODE = 0o700;

const safeName = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Named encrypted values under `userData/secrets/`. A name is a slug, not a path: it becomes a file
 * name, and a caller that could pass `../` could choose any file on disk to overwrite.
 */
export class SecretStore {
  private readonly options: SecretStoreOptions;

  constructor(options: SecretStoreOptions) {
    this.options = options;
  }

  /**
   * Whether anything can be persisted at all. False means sign in on every launch — see the module
   * comment for why that is the behaviour and not a bug to work around.
   */
  isAvailable(): boolean {
    if (!this.assertReady("available")) return false;
    try {
      return this.options.safeStorage.isEncryptionAvailable();
    } catch (error) {
      this.options.log.warn("secrets.availability_failed", { reason: reasonOf(error) });
      return false;
    }
  }

  /** The decrypted value, or null when it is absent, unreadable, or written by another keychain. */
  read(name: string): string | null {
    const path = this.pathFor(name);
    if (!this.isAvailable()) return null;
    let encrypted: Buffer;
    try {
      encrypted = this.options.fs.readFileSync(path);
    } catch {
      // Absent is the normal case on a first launch, and is not worth a log line of its own.
      return null;
    }
    try {
      return this.options.safeStorage.decryptString(encrypted);
    } catch (error) {
      // A blob from another machine, another user account, or a rotated Keychain entry. It will never
      // decrypt, so it is removed rather than left to fail on every launch.
      this.options.log.warn("secrets.undecryptable", { name, reason: reasonOf(error) });
      this.clear(name);
      return null;
    }
  }

  /**
   * Encrypts and writes the value, replacing any previous one. Returns false when nothing was written,
   * which the caller must treat as "this will not survive a restart" rather than as an error.
   *
   * The write is a temp file plus a rename, so a crash mid-write leaves the previous value intact
   * instead of a truncated blob that fails to decrypt.
   */
  write(name: string, plainText: string): boolean {
    const path = this.pathFor(name);
    if (!this.isAvailable()) {
      this.options.log.warn("secrets.write_refused", { name, reason: "encryption_unavailable" });
      return false;
    }
    const temporary = `${path}.tmp`;
    try {
      const encrypted = this.options.safeStorage.encryptString(plainText);
      this.options.fs.mkdirSync(dirname(path), { recursive: true, mode: SECRET_DIR_MODE });
      this.options.fs.writeFileSync(temporary, encrypted, { mode: SECRET_FILE_MODE });
      // `writeFileSync`'s mode applies only when it creates the file; an existing temp file from an
      // interrupted write would keep whatever mode it had.
      this.options.fs.chmodSync(temporary, SECRET_FILE_MODE);
      this.options.fs.renameSync(temporary, path);
      return true;
    } catch (error) {
      this.options.log.error("secrets.write_failed", { name, reason: reasonOf(error) });
      try {
        this.options.fs.rmSync(temporary, { force: true });
      } catch {
        // Nothing more to do: the value was not stored, which is what the caller is told.
      }
      return false;
    }
  }

  /** Removes the value. Absent is success: the point is that it is not there afterwards. */
  clear(name: string): void {
    const path = this.pathFor(name);
    for (const target of [path, `${path}.tmp`]) {
      try {
        this.options.fs.rmSync(target, { force: true });
      } catch (error) {
        this.options.log.error("secrets.clear_failed", { name, reason: reasonOf(error) });
      }
    }
  }

  /** The file a name maps to. Exposed for the tests and for log-free diagnostics; never logged. */
  pathFor(name: string): string {
    if (!safeName.test(name)) throw new TypeError(`not a secret name: ${JSON.stringify(name)}`);
    return join(this.options.userDataPath, "secrets", `${name}.enc`);
  }

  private assertReady(operation: string): boolean {
    if (this.options.isReady()) return true;
    this.options.log.error("secrets.used_before_ready", { operation });
    return false;
  }
}

/** An error's shape for a log field: a code or a class name, never a message that could quote a value. */
function reasonOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
    return error.name;
  }
  return "unknown";
}
