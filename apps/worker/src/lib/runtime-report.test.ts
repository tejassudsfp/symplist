import { describe, expect, it, vi } from "vitest";
import { type ExecFileFn, parseGitVersion, runtimeReport } from "./runtime-report";

describe("parseGitVersion", () => {
  it("extracts the version from standard Git output", () => {
    expect(parseGitVersion("git version 2.50.1 (Apple Git-155)\n")).toBe("2.50.1");
    expect(parseGitVersion("git version 2.47.3")).toBe("2.47.3");
  });

  it("returns null for unexpected output", () => {
    expect(parseGitVersion("")).toBeNull();
    expect(parseGitVersion("command not found")).toBeNull();
  });
});

describe("runtimeReport", () => {
  it("reports Git when the binary responds", async () => {
    const exec = vi.fn<ExecFileFn>().mockResolvedValue({ stdout: "git version 2.47.3\n" });
    const report = await runtimeReport(exec);

    expect(report.git).toBe("2.47.3");
    expect(report.node).toBe(process.version);
    expect(report.rssMb).toBeGreaterThan(0);
  });

  it("calls Git with a fixed argument array and no ambient configuration", async () => {
    const exec = vi.fn<ExecFileFn>().mockResolvedValue({ stdout: "git version 2.47.3" });
    await runtimeReport(exec);

    expect(exec).toHaveBeenCalledTimes(1);
    const call = exec.mock.calls[0];
    if (call === undefined) throw new Error("runtimeReport did not call Git");
    const [file, args, options] = call;
    expect(file).toBe("git");
    expect(args).toEqual(["--version"]);
    expect(options.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", HOME: "/nonexistent" });
    expect(Object.keys(options.env)).not.toContain("GIT_DIR");
  });

  it("reports null Git instead of failing when the binary is missing", async () => {
    const exec = vi
      .fn<ExecFileFn>()
      .mockRejectedValue(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }));
    const report = await runtimeReport(exec);

    expect(report.git).toBeNull();
  });
});
