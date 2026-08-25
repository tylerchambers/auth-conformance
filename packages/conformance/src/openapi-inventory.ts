import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HttpMethod } from "./model.ts";

type AuthoringHttpMethod = Extract<
  HttpMethod,
  "DELETE" | "GET" | "HEAD" | "PATCH" | "POST" | "PUT"
>;

/** Describes one supported operation discovered in an OpenAPI document. */
export type InventoryOperation = {
  readonly operationId: string;
  readonly method: AuthoringHttpMethod;
  readonly path: string;
  readonly tags: readonly string[];
};

const operationInventoryBrand = Symbol("OperationInventory");
/** Holds validated operations for inventory-backed authorization rules. */
export type OperationInventory = {
  readonly [operationInventoryBrand]: true;
  readonly operations: readonly InventoryOperation[];
};

const supportedMethods = [
  "delete",
  "get",
  "head",
  "patch",
  "post",
  "put",
] as const;

const authoringMethodByOpenApiMethod: Record<
  (typeof supportedMethods)[number],
  AuthoringHttpMethod
> = {
  delete: "DELETE",
  get: "GET",
  head: "HEAD",
  patch: "PATCH",
  post: "POST",
  put: "PUT",
};

/**
 * Builds an immutable operation inventory from a document or local JSON file.
 *
 * Supports DELETE, GET, HEAD, PATCH, POST, and PUT operations. Every discovered
 * operation must have a unique `operationId`; remote URLs are not fetched.
 *
 * @throws When the document shape, operation IDs, tags, or URL are invalid.
 */
export function fromOpenApi(documentOrUrl: unknown): OperationInventory {
  const document = readOpenApiDocument(documentOrUrl);
  if (!isPlainRecord(document.paths)) {
    throw new Error("OpenAPI document must contain a paths object");
  }

  const operations: InventoryOperation[] = [];
  const operationIds = new Set<string>();
  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!isPlainRecord(pathItem)) {
      continue;
    }
    for (const method of supportedMethods) {
      const candidate = pathItem[method];
      if (candidate === undefined) {
        continue;
      }
      if (
        !isPlainRecord(candidate) ||
        typeof candidate.operationId !== "string"
      ) {
        throw new Error(
          `OpenAPI operation ${method.toUpperCase()} ${path} must have an operationId`,
        );
      }
      if (operationIds.has(candidate.operationId)) {
        throw new Error(
          `Duplicate OpenAPI operation ID "${candidate.operationId}"`,
        );
      }
      operationIds.add(candidate.operationId);
      operations.push({
        operationId: candidate.operationId,
        method: authoringMethodByOpenApiMethod[method],
        path,
        tags: readTags(candidate.tags, candidate.operationId),
      });
    }
  }

  return Object.freeze({
    [operationInventoryBrand]: true,
    operations: Object.freeze(operations),
  });
}

function readOpenApiDocument(documentOrUrl: unknown): Record<string, unknown> {
  if (isPlainRecord(documentOrUrl)) {
    return documentOrUrl;
  }
  if (typeof documentOrUrl !== "string" && !(documentOrUrl instanceof URL)) {
    throw new TypeError(
      "fromOpenApi expects an OpenAPI document or local file URL",
    );
  }

  const path = openApiFilePath(documentOrUrl);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isPlainRecord(parsed)) {
    throw new Error(`OpenAPI file "${path}" must contain a JSON object`);
  }
  return parsed;
}

function openApiFilePath(value: string | URL): string {
  if (value instanceof URL) {
    if (value.protocol !== "file:") {
      throw new Error(
        `fromOpenApi cannot synchronously load ${value.protocol} URLs; pass the parsed document instead`,
      );
    }
    return fileURLToPath(value);
  }
  if (/^https?:\/\//i.test(value)) {
    throw new Error(
      "fromOpenApi cannot synchronously load HTTP URLs; pass the parsed document instead",
    );
  }
  return value;
}

function readTags(value: unknown, operationId: string): readonly string[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string")) {
    throw new Error(`OpenAPI operation "${operationId}" has invalid tags`);
  }
  return Object.freeze([...value]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
