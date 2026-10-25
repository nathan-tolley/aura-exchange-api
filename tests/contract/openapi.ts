import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";

/** Validates /v1 responses against openapi/v1.yaml, the contract with the app. */

type Json = Record<string, unknown>;

const SPEC_ID = "openapi.json";
export const spec = parse(readFileSync(path.resolve("openapi/v1.yaml"), "utf8")) as Json & {
  paths: Record<string, Record<string, Json>>;
  components: { schemas: Record<string, Json>; responses: Record<string, Json> };
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
ajv.addSchema(spec, SPEC_ID, undefined, false);

const pointer = (...segments: string[]) => segments.map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1")).join("/");
const validators = new Map<string, ValidateFunction>();

function validatorFor(ref: string): ValidateFunction {
  let validate = validators.get(ref);
  if (!validate) {
    validate = ajv.compile({ $ref: `${SPEC_ID}#${ref}` });
    validators.set(ref, validate);
  }
  return validate;
}

function explain(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "(root)"} ${error.message ?? "is invalid"} ${JSON.stringify(error.params)}`).join("\n");
}

/** Throws unless `body` is exactly what the spec declares for this operation and status. */
export function expectResponseMatchesSpec(method: string, specPath: string, status: number, body: unknown): void {
  const operation = spec.paths[specPath]?.[method.toLowerCase()] as { responses?: Record<string, Json> } | undefined;
  if (!operation) throw new Error(`The spec has no operation ${method.toUpperCase()} ${specPath}`);
  let response = operation.responses?.[String(status)];
  if (!response) throw new Error(`${method.toUpperCase()} ${specPath} does not declare a ${status} response`);
  let responsePointer = `/${pointer("paths", specPath, method.toLowerCase(), "responses", String(status))}`;
  const ref = response.$ref;
  if (typeof ref === "string") {
    const name = ref.replace("#/components/responses/", "");
    response = spec.components.responses[name];
    if (!response) throw new Error(`Unresolved response ${ref}`);
    responsePointer = `/${pointer("components", "responses", name)}`;
  }
  const content = response.content as Record<string, { schema?: unknown }> | undefined;
  if (!content) {
    if (body !== undefined && body !== "" && body !== null) throw new Error(`${status} declares no body, got ${JSON.stringify(body)}`);
    return;
  }
  if (!content["application/json"]?.schema) throw new Error(`${status} has no application/json schema`);
  const validate = validatorFor(`${responsePointer}/${pointer("content", "application/json", "schema")}`);
  if (!validate(body)) throw new Error(`${method.toUpperCase()} ${specPath} ${status} does not match the spec:\n${explain(validate.errors)}\nbody: ${JSON.stringify(body)}`);
  if (status >= 200 && status < 300) {
    const problems: string[] = [];
    shapeProblems(content["application/json"].schema as Json, body, "", problems);
    if (problems.length) throw new Error(`${method.toUpperCase()} ${specPath} ${status} differs from what the Prism mock serves:\n${problems.join("\n")}`);
  }
}

function resolve(schema: Json): Json {
  let current = schema;
  while (typeof current.$ref === "string") current = spec.components.schemas[current.$ref.replace("#/components/schemas/", "")] as Json;
  return current;
}

/**
 * The Prism mock serves every property the spec declares and nothing else, so the real server must too: same
 * shapes, all the way down. Nullable values and free-form maps (additionalProperties) are left alone.
 */
function shapeProblems(rawSchema: Json, value: unknown, at: string, problems: string[]): void {
  if (value === null || value === undefined) return;
  const schema = resolve(rawSchema);
  const options = (schema.oneOf ?? schema.anyOf) as Json[] | undefined;
  if (options) {
    const concrete = options.map(resolve).filter((option) => option.type !== "null");
    if (concrete.length === 1) shapeProblems(concrete[0]!, value, at, problems);
    return;
  }
  const parts = schema.allOf ? (schema.allOf as Json[]).map(resolve) : [schema];
  const types = parts.flatMap((part) => (Array.isArray(part.type) ? part.type : [part.type]));
  if (types.includes("array") && Array.isArray(value)) {
    const items = parts.find((part) => part.items)?.items as Json | undefined;
    if (items) value.slice(0, 3).forEach((item, index) => shapeProblems(items, item, `${at}[${index}]`, problems));
    return;
  }
  const properties: Record<string, Json> = Object.assign({}, ...parts.map((part) => (part.properties ?? {}) as Record<string, Json>));
  if (!Object.keys(properties).length || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const [key, property] of Object.entries(properties)) {
    if (!(key in record)) problems.push(`${at}.${key} is missing`);
    else shapeProblems(property, record[key], `${at}.${key}`, problems);
  }
  if (!parts.some((part) => part.additionalProperties)) {
    for (const key of Object.keys(record)) if (!(key in properties)) problems.push(`${at}.${key} is not in the spec`);
  }
}

/** Throws unless `value` matches a named component schema (e.g. "Error"). */
export function expectSchema(name: string, value: unknown): void {
  if (!spec.components.schemas[name]) throw new Error(`The spec has no schema ${name}`);
  const validate = validatorFor(`/${pointer("components", "schemas", name)}`);
  if (!validate(value)) throw new Error(`Value does not match ${name}:\n${explain(validate.errors)}\nvalue: ${JSON.stringify(value)}`);
}
