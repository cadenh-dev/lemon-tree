// A validator for the JSON Schema subset that the orchestration schemas use.
// The workspace root has no dependencies, and the trust base must not add one.
// An unknown keyword is an error, so a schema cannot rely on a rule that this file does not check.

export type Schema = { [keyword: string]: unknown };

const ANNOTATIONS = new Set(["$schema", "$id", "description"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validate(schema: Schema, value: unknown, path = "$"): string[] {
  const issues: string[] = [];
  for (const [keyword, rule] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword)) continue;
    const check = KEYWORDS[keyword];
    if (check === undefined) issues.push(`${path}: the schema keyword "${keyword}" is not supported`);
    else issues.push(...check(rule, value, path, schema));
  }
  return issues;
}

export async function loadSchema(file: string): Promise<Schema> {
  return (await Bun.file(file).json()) as Schema;
}

type Check = (rule: unknown, value: unknown, path: string, schema: Schema) => string[];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function typeOf(value: unknown) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

const KEYWORDS: Record<string, Check> = {
  type: (rule, value, path) => {
    const actual = typeOf(value);
    const allowed = Array.isArray(rule) ? (rule as string[]) : [rule as string];
    return allowed.includes(actual) || (actual === "integer" && allowed.includes("number")) ? [] : [`${path}: expected ${allowed.join(" or ")}, got ${actual}`];
  },
  const: (rule, value, path) => (JSON.stringify(value) === JSON.stringify(rule) ? [] : [`${path}: expected the constant ${JSON.stringify(rule)}`]),
  enum: (rule, value, path) => ((rule as unknown[]).some(item => JSON.stringify(item) === JSON.stringify(value)) ? [] : [`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(rule)}`]),
  pattern: (rule, value, path) => (typeof value !== "string" || new RegExp(rule as string).test(value) ? [] : [`${path}: does not match ${rule}`]),
  format: (rule, value, path) => (rule !== "date" ? [`${path}: the format "${rule}" is not supported`] : typeof value !== "string" || DATE.test(value) ? [] : [`${path}: is not a date (YYYY-MM-DD)`]),
  minLength: (rule, value, path) => (typeof value !== "string" || value.length >= (rule as number) ? [] : [`${path}: shorter than ${rule} characters`]),
  maxLength: (rule, value, path) => (typeof value !== "string" || value.length <= (rule as number) ? [] : [`${path}: longer than ${rule} characters (${value.length})`]),
  minimum: (rule, value, path) => (typeof value !== "number" || value >= (rule as number) ? [] : [`${path}: less than ${rule}`]),
  maximum: (rule, value, path) => (typeof value !== "number" || value <= (rule as number) ? [] : [`${path}: more than ${rule}`]),
  minItems: (rule, value, path) => (!Array.isArray(value) || value.length >= (rule as number) ? [] : [`${path}: fewer than ${rule} items`]),
  maxItems: (rule, value, path) => (!Array.isArray(value) || value.length <= (rule as number) ? [] : [`${path}: more than ${rule} items (${value.length})`]),
  required: (rule, value, path) => (isObject(value) ? (rule as string[]).filter(key => !(key in value)).map(key => `${path}: the required field "${key}" is missing`) : []),
  properties: (rule, value, path) => (isObject(value) ? Object.entries(rule as Record<string, Schema>).flatMap(([key, child]) => (key in value ? validate(child, value[key], `${path}.${key}`) : [])) : []),
  additionalProperties: (rule, value, path, schema) => {
    if (rule !== false) return [`${path}: only "additionalProperties": false is supported`];
    return isObject(value) ? Object.keys(value).filter(key => !(key in ((schema.properties as object | undefined) ?? {}))).map(key => `${path}: the field "${key}" is not allowed`) : [];
  },
  items: (rule, value, path) => (Array.isArray(value) ? value.flatMap((item, index) => validate(rule as Schema, item, `${path}[${index}]`)) : []),
  oneOf: (rule, value, path) => {
    const results = (rule as Schema[]).map(option => validate(option, value, path));
    const matches = results.filter(issues => issues.length === 0).length;
    if (matches === 1) return [];
    return matches > 1 ? [`${path}: matches ${matches} alternatives, expected one`] : [`${path}: matches no alternative (${results.map(issues => issues[0]).join(" | ")})`];
  },
};
