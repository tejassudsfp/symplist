import { describe, expect, it } from "vitest";
import { API_ORIGIN_ENV, CloudConfigError, resolveCloudConfig, WEB_ORIGIN_ENV } from "./config.ts";

describe("the cloud configuration", () => {
  it("defaults to the closed beta's cloud", () => {
    const config = resolveCloudConfig({});
    expect(config.apiOrigin.startsWith("https://")).toBe(true);
    expect(config.webOrigin.startsWith("https://")).toBe(true);
    expect(config.apiOrigin).not.toBe(config.webOrigin);
  });

  it("strips a trailing slash, so it cannot become a mystery auth.origin_forbidden", () => {
    // RouteClassGuard.checkOrigin compares Origin to WEB_ORIGIN with ===, and an origin has no path.
    const config = resolveCloudConfig({
      [API_ORIGIN_ENV]: "http://localhost:4000/",
      [WEB_ORIGIN_ENV]: " http://localhost:3000/ ",
    });
    expect(config).toEqual({
      apiOrigin: "http://localhost:4000",
      webOrigin: "http://localhost:3000",
    });
  });

  it("drops a path and a query, keeping only the origin", () => {
    expect(resolveCloudConfig({ [API_ORIGIN_ENV]: "https://api.test/v1?x=1" }).apiOrigin).toBe(
      "https://api.test",
    );
  });

  it("refuses an override that is not an http origin rather than falling back", () => {
    // A typo that silently pointed the app at production would be worse than a refusal to start.
    for (const value of ["", "   ", "api.test", "ftp://api.test", "https://u:p@api.test"]) {
      expect(() => resolveCloudConfig({ [API_ORIGIN_ENV]: value }), value).toThrow(
        CloudConfigError,
      );
    }
  });
});
