import type { StandardSchemaValidationPipeOptions } from "@nestjs/common";
import type { ValidationIssue } from "@symplist/contracts";
import { ApiError } from "./api-error.ts";

/** Fixed messages by issue code, so a validation error never echoes submitted values (§6). */
const issueMessages: Readonly<Record<string, string>> = {
  invalid_type: "Invalid type",
  too_small: "Too small",
  too_big: "Too large",
  invalid_format: "Invalid format",
  invalid_value: "Invalid value",
  invalid_union: "Invalid value",
  invalid_key: "Invalid key",
  invalid_element: "Invalid element",
  not_multiple_of: "Invalid value",
  unrecognized_keys: "Unrecognized fields",
  custom: "Invalid value",
  malformed_request: "The request could not be parsed",
};

const issueCodePattern = /^[a-z_]{1,64}$/;

/** Standard Schema issues as Nest's validation pipe passes them. */
export type SchemaIssues = Parameters<
  NonNullable<StandardSchemaValidationPipeOptions["exceptionFactory"]>
>[0];
type SchemaIssue = SchemaIssues[number];
type SchemaPathSegment = NonNullable<SchemaIssue["path"]>[number];

function pathSegment(segment: SchemaPathSegment): string | number | null {
  const key = typeof segment === "object" && segment !== null ? segment.key : segment;
  if (typeof key === "number") return Number.isSafeInteger(key) && key >= 0 ? key : null;
  if (typeof key === "string") return key.length <= 200 ? key : null;
  return null;
}

/** Maps Standard Schema issues to the `validation` details shape with fixed messages. */
export function toValidationIssues(issues: SchemaIssues): readonly ValidationIssue[] {
  return issues.slice(0, 100).map((issue) => {
    const rawCode = (issue as { code?: unknown }).code;
    const code = typeof rawCode === "string" && issueCodePattern.test(rawCode) ? rawCode : "custom";
    const path = (issue.path ?? [])
      .slice(0, 32)
      .map(pathSegment)
      .filter((segment): segment is string | number => segment !== null);
    return { path, code, message: issueMessages[code] ?? "Invalid value" };
  });
}

/** The `StandardSchemaValidationPipe` exception factory: a `validation` envelope (§6). */
export function validationExceptionFactory(issues: SchemaIssues): ApiError {
  const mapped = toValidationIssues(issues);
  return ApiError.validation(
    mapped.length > 0 ? mapped : [{ path: [], code: "custom", message: "Invalid value" }],
  );
}

/** The `validation` error for a body or URL that could not be parsed at all. */
export function malformedRequestError(): ApiError {
  return ApiError.validation([
    { path: [], code: "malformed_request", message: issueMessages.malformed_request ?? "" },
  ]);
}
