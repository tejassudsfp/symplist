import { describe, expect, it } from "vitest";
import { silentMainLog } from "../log.ts";
import { type SafeStorageLike, type SecretFileSystem, SecretStore } from "./secret-store.ts";

/** A safeStorage whose "encryption" is reversible in a test but not a passthrough of the plaintext. */
function fakeSafeStorage(
  available = true,
): SafeStorageLike & { readonly encryptCalls: () => number } {
  let calls = 0;
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => {
      calls += 1;
      return Buffer.concat([Buffer.from("v10"), Buffer.from(value, "utf8").reverse()]);
    },
    decryptString: (buffer) => {
      if (buffer.subarray(0, 3).toString("utf8") !== "v10") throw new Error("bad blob");
      return Buffer.from(buffer.subarray(3)).reverse().toString("utf8");
    },
    encryptCalls: () => calls,
  };
}

interface FakeFs extends SecretFileSystem {
  readonly files: Map<string, Buffer>;
  readonly modes: Map<string, number>;
}

function fakeFs(overrides: Partial<SecretFileSystem> = {}): FakeFs {
  const files = new Map<string, Buffer>();
  const modes = new Map<string, number>();
  const base: SecretFileSystem = {
    readFileSync: (path) => {
      const file = files.get(path);
      if (!file) {
        const error = new Error("no such file") as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }
      return file;
    },
    writeFileSync: (path, data, options) => {
      files.set(path, Buffer.from(data));
      modes.set(path, options.mode);
    },
    mkdirSync: () => undefined,
    chmodSync: (path, mode) => {
      modes.set(path, mode);
    },
    renameSync: (from, to) => {
      const file = files.get(from);
      if (file) {
        files.set(to, file);
        files.delete(from);
      }
      const mode = modes.get(from);
      if (mode !== undefined) {
        modes.set(to, mode);
        modes.delete(from);
      }
    },
    rmSync: (path) => {
      files.delete(path);
      modes.delete(path);
    },
  };
  return { ...base, ...overrides, files, modes };
}

function store(options: { safeStorage?: SafeStorageLike; fs?: FakeFs; isReady?: () => boolean }): {
  store: SecretStore;
  fs: FakeFs;
} {
  const fs = options.fs ?? fakeFs();
  return {
    store: new SecretStore({
      userDataPath: "/userData",
      safeStorage: options.safeStorage ?? fakeSafeStorage(),
      log: silentMainLog,
      fs,
      isReady: options.isReady ?? (() => true),
    }),
    fs,
  };
}

describe("the secret store", () => {
  it("round-trips a value without ever writing the plaintext", () => {
    const { store: secrets, fs } = store({});
    expect(secrets.write("cloud-session", "the-cookie")).toBe(true);
    expect(secrets.read("cloud-session")).toBe("the-cookie");
    const written = [...fs.files.values()].map((file) => file.toString("utf8"));
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain("the-cookie");
  });

  it("writes owner-only files through a temporary name", () => {
    const { store: secrets, fs } = store({});
    secrets.write("cloud-session", "value");
    const path = secrets.pathFor("cloud-session");
    expect([...fs.files.keys()]).toEqual([path]);
    expect(fs.modes.get(path)).toBe(0o600);
  });

  it("refuses to write and reads nothing when encryption is unavailable", () => {
    const safeStorage = fakeSafeStorage(false);
    const { store: secrets, fs } = store({ safeStorage });
    expect(secrets.write("cloud-session", "value")).toBe(false);
    expect(fs.files.size).toBe(0);
    expect(safeStorage.encryptCalls()).toBe(0);
    expect(secrets.read("cloud-session")).toBeNull();
  });

  it("answers nothing before Electron is ready, because safeStorage would answer wrongly", () => {
    // Measured on Electron 44: isEncryptionAvailable() is false before whenReady and true after, so a
    // store consulted too early would conclude the machine cannot encrypt and stop persisting.
    let ready = false;
    const { store: secrets } = store({ isReady: () => ready });
    expect(secrets.isAvailable()).toBe(false);
    expect(secrets.write("cloud-session", "value")).toBe(false);
    ready = true;
    expect(secrets.isAvailable()).toBe(true);
    expect(secrets.write("cloud-session", "value")).toBe(true);
  });

  it("removes a blob it cannot decrypt instead of failing on every launch", () => {
    const { store: secrets, fs } = store({});
    const path = secrets.pathFor("cloud-session");
    // A blob from another machine, another user, or a rotated keychain entry.
    fs.files.set(path, Buffer.from("not ours"));
    expect(secrets.read("cloud-session")).toBeNull();
    expect(fs.files.has(path)).toBe(false);
  });

  it("reports a failed write rather than throwing, and leaves no temporary file", () => {
    const fs = fakeFs({
      renameSync: () => {
        throw new Error("EXDEV");
      },
    });
    const { store: secrets } = store({ fs });
    expect(secrets.write("cloud-session", "value")).toBe(false);
    expect(fs.files.size).toBe(0);
  });

  it("clears a value and its temporary file, and treats an absent one as cleared", () => {
    const { store: secrets, fs } = store({});
    secrets.write("cloud-session", "value");
    fs.files.set(`${secrets.pathFor("cloud-session")}.tmp`, Buffer.from("leftover"));
    secrets.clear("cloud-session");
    expect(fs.files.size).toBe(0);
    expect(() => secrets.clear("cloud-session")).not.toThrow();
  });

  it("refuses a name that is a path", () => {
    const { store: secrets } = store({});
    for (const name of ["../escape", "a/b", "", "Upper", "9lives", "a".repeat(64)]) {
      expect(() => secrets.pathFor(name), name).toThrow(TypeError);
    }
    expect(secrets.pathFor("cloud-session")).toBe("/userData/secrets/cloud-session.enc");
  });
});
