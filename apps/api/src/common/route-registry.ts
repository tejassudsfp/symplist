import { type INestApplicationContext, RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants.js";
import { MetadataScanner, ModulesContainer } from "@nestjs/core";
import { ACCESS_METADATA, type AccessRequirement } from "./access.decorator.ts";
import { publicRoutePath } from "./http/global-prefix.ts";
import { IDEMPOTENT_METADATA, type IdempotentRequirement } from "./idempotent.decorator.ts";
import {
  isRouteClass,
  type RequestMethodName,
  ROUTE_CLASS_METADATA,
  type RouteClass,
  type RouteClassRegistry,
  type RouteKey,
  routeClassRules,
} from "./route-classes.ts";

/** One HTTP route of the application with its declared platform metadata. */
export interface RegisteredRoute {
  readonly key: RouteKey;
  readonly method: RequestMethodName;
  readonly path: string;
  readonly controller: string;
  readonly handler: string;
  readonly routeClass: RouteClass | null;
  readonly access: AccessRequirement | null;
  readonly idempotent: IdempotentRequirement | null;
}

type Handler = (...args: unknown[]) => unknown;

function paths(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [typeof value === "string" ? value : "/"];
}

function methodName(value: unknown): RequestMethodName | null {
  const name = typeof value === "number" ? RequestMethod[value] : undefined;
  switch (name) {
    case "GET":
    case "HEAD":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
    case "ALL":
      return name;
    default:
      return null;
  }
}

function metadata<T>(key: string, handler: Handler, controller: object): T | null {
  const value =
    (Reflect.getMetadata(key, handler) as T | undefined) ??
    (Reflect.getMetadata(key, controller) as T | undefined);
  return value ?? null;
}

/** Every controller route of an application, read from Nest's module container. */
export function collectRoutes(app: INestApplicationContext): RegisteredRoute[] {
  return collectRoutesFromContainer(app.get(ModulesContainer));
}

/** Every controller route registered in a module container. */
export function collectRoutesFromContainer(container: ModulesContainer): RegisteredRoute[] {
  const scanner = new MetadataScanner();
  const routes: RegisteredRoute[] = [];
  const seen = new Set<object>();
  for (const module of container.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      if (typeof controller !== "function" || seen.has(controller)) continue;
      seen.add(controller);
      const prototype = controller.prototype as Record<string, unknown>;
      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== "function") continue;
        const rawMethod = Reflect.getMetadata(METHOD_METADATA, handler) as unknown;
        if (rawMethod === undefined) continue;
        const method = methodName(rawMethod);
        const routeClass = metadata<unknown>(ROUTE_CLASS_METADATA, handler as Handler, controller);
        for (const controllerPath of paths(Reflect.getMetadata(PATH_METADATA, controller))) {
          for (const handlerPath of paths(Reflect.getMetadata(PATH_METADATA, handler))) {
            const path = publicRoutePath(`${controllerPath}/${handlerPath}`);
            const verb = method ?? "ALL";
            routes.push({
              key: `${verb === "HEAD" ? "GET" : verb} ${path}` as RouteKey,
              method: verb,
              path,
              controller: controller.name,
              handler: name,
              routeClass: isRouteClass(routeClass) ? routeClass : null,
              access: metadata<AccessRequirement>(ACCESS_METADATA, handler as Handler, controller),
              idempotent: metadata<IdempotentRequirement>(
                IDEMPOTENT_METADATA,
                handler as Handler,
                controller,
              ),
            });
          }
        }
      }
    }
  }
  return routes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The route-class registry of an application (§5.3). */
export function buildRouteClassRegistry(routes: readonly RegisteredRoute[]): RouteClassRegistry {
  const registry: Partial<Record<RouteKey, RouteClass>> = {};
  for (const route of routes) {
    if (route.routeClass) registry[route.key] = route.routeClass;
  }
  return Object.freeze(registry);
}

/**
 * Every way the declared routes break §5.3: a missing class, a class on a method or path it does
 * not allow, `@Access` on a class that never reads the session cookie or missing where required,
 * and `@Idempotent` without a session.
 */
export function routeClassViolations(routes: readonly RegisteredRoute[]): string[] {
  const problems: string[] = [];
  for (const route of routes) {
    const where = `${route.key} (${route.controller}.${route.handler})`;
    if (!route.routeClass) {
      problems.push(`${where} declares no @RouteClass`);
      continue;
    }
    const rule = routeClassRules[route.routeClass];
    if (!rule.methods.includes(route.method)) {
      problems.push(`${where}: ${route.routeClass} does not allow ${route.method}`);
    }
    if (
      !rule.pathPrefixes.some((prefix) => route.path === prefix || route.path.startsWith(prefix))
    ) {
      problems.push(`${where}: ${route.routeClass} is not allowed under this path`);
    }
    if (rule.sessionAccess === "forbidden" && route.access) {
      problems.push(`${where}: ${route.routeClass} never reads the session, so @Access is invalid`);
    }
    if (rule.sessionAccess === "required" && !route.access) {
      problems.push(`${where}: ${route.routeClass} requires @Access`);
    }
    if (route.idempotent && (!route.access || route.method === "GET" || route.method === "HEAD")) {
      problems.push(`${where}: @Idempotent needs @Access and an unsafe method`);
    }
  }
  return problems;
}

/** Thrown at bootstrap when a route breaks the route-class rules. */
export class RouteClassViolationError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Route class violations:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "RouteClassViolationError";
    this.problems = Object.freeze([...problems]);
  }
}
