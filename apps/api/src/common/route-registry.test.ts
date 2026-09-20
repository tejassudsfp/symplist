import { Controller, Get, Module, Post } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApp, type TestApp } from "../../test/harness.ts";
import { Access } from "./access.decorator.ts";
import { Idempotent } from "./idempotent.decorator.ts";
import { RouteClass, type RouteClass as RouteClassName, routeClasses } from "./route-classes.ts";
import {
  buildRouteClassRegistry,
  collectRoutes,
  type RegisteredRoute,
  RouteClassViolationError,
  routeClassViolations,
} from "./route-registry.ts";

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("route-class coverage (§5.3)", () => {
  it("gives every registered controller route of the application a valid class", async () => {
    app = await bootTestApp();
    const routes = collectRoutes(app.app);
    expect(routes.length).toBeGreaterThan(0);
    const unclassified = routes
      .filter((route) => route.routeClass === null)
      .map((route) => route.key);
    expect(unclassified).toEqual([]);
    expect(routeClassViolations(routes)).toEqual([]);
    const registry = buildRouteClassRegistry(routes);
    expect(registry["GET /healthz"]).toBe("public_read");
    expect(registry["GET /v1/auth/csrf"]).toBe("app");
    expect(Object.keys(registry)).toHaveLength(routes.length);
  });

  it("refuses to boot an application with an unclassified route", async () => {
    @Controller()
    class UnclassifiedController {
      @Get("forgotten")
      forgotten() {
        return {};
      }
    }
    @Module({ controllers: [UnclassifiedController] })
    class UnclassifiedModule {}

    const failure = await bootTestApp({ imports: [UnclassifiedModule] }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RouteClassViolationError);
    expect((failure as RouteClassViolationError).problems).toEqual([
      "GET /v1/forgotten (UnclassifiedController.forgotten) declares no @RouteClass",
    ]);
  });

  it("refuses classes on methods, paths or access declarations their rules forbid", async () => {
    @Controller()
    @RouteClass("app")
    class MisusedController {
      @Get("no-access")
      missingAccess() {
        return {};
      }

      @Post("auth/lookup")
      @RouteClass("pre_session")
      @Access("identity")
      preSessionWithAccess() {
        return {};
      }

      @Get("webhooks/probe")
      @RouteClass("signed")
      signedGet() {
        return {};
      }

      @Get("probe")
      @RouteClass("share_read")
      shareOffPath() {
        return {};
      }

      @Get("idem")
      @Access("identity")
      @Idempotent()
      idempotentGet() {
        return {};
      }
    }
    @Module({ controllers: [MisusedController] })
    class MisusedModule {}

    const failure = (await bootTestApp({ imports: [MisusedModule] }).catch(
      (error: unknown) => error,
    )) as RouteClassViolationError;
    expect(failure).toBeInstanceOf(RouteClassViolationError);
    expect(failure.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "GET /v1/no-access (MisusedController.missingAccess): app requires @Access",
        ),
        expect.stringContaining("pre_session never reads the session, so @Access is invalid"),
        expect.stringContaining(
          "GET /webhooks/probe (MisusedController.signedGet): signed does not allow GET",
        ),
        expect.stringContaining(
          "GET /v1/probe (MisusedController.shareOffPath): share_read is not allowed under this path",
        ),
        expect.stringContaining("@Idempotent needs @Access and an unsafe method"),
      ]),
    );
  });

  it("lets every class be declared on its own path and method", () => {
    const valid: Record<
      RouteClassName,
      Pick<RegisteredRoute, "method" | "path"> & { access: boolean }
    > = {
      app: { method: "POST", path: "/v1/tasks", access: true },
      pre_session: { method: "POST", path: "/v1/auth/otp", access: false },
      connection_callback: { method: "GET", path: "/v1/connections/callback", access: true },
      share_form: { method: "POST", path: "/artifact/:id/password", access: false },
      share_read: { method: "GET", path: "/artifact/:id", access: false },
      oauth_public: { method: "POST", path: "/oauth/token", access: false },
      oauth_authorize: { method: "GET", path: "/oauth/authorize", access: false },
      mcp: { method: "ALL", path: "/mcp", access: false },
      signed: { method: "POST", path: "/internal/v1/events", access: false },
      public_read: {
        method: "GET",
        path: "/.well-known/oauth-authorization-server",
        access: false,
      },
    };
    expect(Object.keys(valid).sort()).toEqual([...routeClasses].sort());
    const routes: RegisteredRoute[] = Object.entries(valid).map(([routeClass, route]) => ({
      key: `${route.method === "ALL" ? "ALL" : route.method} ${route.path}` as RegisteredRoute["key"],
      method: route.method,
      path: route.path,
      controller: "Probe",
      handler: routeClass,
      routeClass: routeClass as RouteClassName,
      access: route.access ? { level: "identity", fresh: false } : null,
      idempotent: null,
    }));
    expect(routeClassViolations(routes)).toEqual([]);
  });
});
