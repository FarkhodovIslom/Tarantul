export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Parameter casting / validation helpers
// ---------------------------------------------------------------------------

function resolveType(t: unknown): string | null {
  if (Array.isArray(t)) {
    for (const item of t) {
      if (item !== "null") return item as string;
    }
    return null;
  }
  return typeof t === "string" ? t : null;
}

function castValue(val: unknown, schema: Record<string, unknown>): unknown {
  const targetType = resolveType(schema["type"]);

  if (targetType === "boolean" && typeof val === "boolean") return val;
  if (targetType === "integer" && typeof val === "number" && Number.isInteger(val)) return val;
  if (targetType === "number" && typeof val === "number") return val;
  if (targetType === "string" && typeof val === "string") return val;

  if (targetType === "integer" && typeof val === "string") {
    const n = parseInt(val, 10);
    return isNaN(n) ? val : n;
  }
  if (targetType === "number" && typeof val === "string") {
    const n = parseFloat(val);
    return isNaN(n) ? val : n;
  }
  if (targetType === "string") return val == null ? val : String(val);
  if (targetType === "boolean" && typeof val === "string") {
    if (["true", "1", "yes"].includes(val.toLowerCase())) return true;
    if (["false", "0", "no"].includes(val.toLowerCase())) return false;
    return val;
  }
  if (targetType === "array" && Array.isArray(val)) {
    const itemSchema = schema["items"] as Record<string, unknown> | undefined;
    return itemSchema ? val.map((item) => castValue(item, itemSchema)) : val;
  }
  if (targetType === "object" && typeof val === "object" && val !== null && !Array.isArray(val)) {
    return castObject(val as Record<string, unknown>, schema);
  }
  return val;
}

function castObject(
  obj: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const props = (schema["properties"] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = key in props ? castValue(value, props[key]!) : value;
  }
  return result;
}

function validateValue(val: unknown, schema: Record<string, unknown>, path: string): string[] {
  const rawType = schema["type"];
  const nullable =
    (Array.isArray(rawType) && rawType.includes("null")) || schema["nullable"] === true;
  const t = resolveType(rawType);
  const label = path || "parameter";

  if (nullable && val == null) return [];

  const errors: string[] = [];

  if (t === "integer") {
    if (typeof val !== "number" || !Number.isInteger(val) || typeof val === "boolean") {
      errors.push(`${label} should be integer`);
    }
  } else if (t === "number") {
    if (typeof val !== "number" || typeof val === "boolean") {
      errors.push(`${label} should be number`);
    }
  } else if (t === "string" && typeof val !== "string") {
    errors.push(`${label} should be string`);
  } else if (t === "boolean" && typeof val !== "boolean") {
    errors.push(`${label} should be boolean`);
  } else if (t === "array" && !Array.isArray(val)) {
    errors.push(`${label} should be array`);
  } else if (t === "object" && (typeof val !== "object" || val === null || Array.isArray(val))) {
    errors.push(`${label} should be object`);
  }

  if (errors.length > 0) return errors;

  const enumVals = schema["enum"] as unknown[] | undefined;
  if (enumVals && !enumVals.includes(val)) {
    errors.push(`${label} must be one of ${JSON.stringify(enumVals)}`);
  }

  if ((t === "integer" || t === "number") && typeof val === "number") {
    const min = schema["minimum"] as number | undefined;
    const max = schema["maximum"] as number | undefined;
    if (min !== undefined && val < min) errors.push(`${label} must be >= ${min}`);
    if (max !== undefined && val > max) errors.push(`${label} must be <= ${max}`);
  }

  if (t === "string" && typeof val === "string") {
    const minLen = schema["minLength"] as number | undefined;
    const maxLen = schema["maxLength"] as number | undefined;
    if (minLen !== undefined && val.length < minLen) {
      errors.push(`${label} must be at least ${minLen} chars`);
    }
    if (maxLen !== undefined && val.length > maxLen) {
      errors.push(`${label} must be at most ${maxLen} chars`);
    }
  }

  if (t === "object" && typeof val === "object" && val !== null) {
    const obj = val as Record<string, unknown>;
    const props = (schema["properties"] as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const k of (schema["required"] as string[] | undefined) ?? []) {
      if (!(k in obj)) {
        errors.push(`missing required ${path ? `${path}.${k}` : k}`);
      }
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) {
        errors.push(...validateValue(v, props[k]!, path ? `${path}.${k}` : k));
      }
    }
  }

  if (t === "array" && Array.isArray(val)) {
    const itemSchema = schema["items"] as Record<string, unknown> | undefined;
    if (itemSchema) {
      val.forEach((item, i) => {
        errors.push(...validateValue(item, itemSchema, path ? `${path}[${i}]` : `[${i}]`));
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Abstract Tool base class
// ---------------------------------------------------------------------------

export abstract class Tool {
  /** Tool name used in function calls. */
  abstract readonly name: string;

  /** Human-readable description. */
  abstract readonly description: string;

  /** JSON Schema for tool parameters. */
  abstract readonly parameters: Record<string, unknown>;

  /** Whether this tool is side-effect free and safe to parallelize. */
  get readOnly(): boolean { return false; }

  /** Whether this tool can run alongside other concurrency-safe tools. */
  get concurrencySafe(): boolean { return this.readOnly && !this.exclusive; }

  /** Whether this tool should run alone even if concurrency is enabled. */
  get exclusive(): boolean { return false; }

  /** Execute the tool. Returns a string or list of content blocks. */
  abstract execute(params: Record<string, unknown>): Promise<unknown>;

  castParams(params: Record<string, unknown>): Record<string, unknown> {
    const schema = this.parameters;
    if ((schema["type"] as string | undefined) !== "object" && schema["type"] != null) {
      return params;
    }
    return castObject(params, schema);
  }

  validateParams(params: Record<string, unknown>): string[] {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return [`parameters must be an object, got ${typeof params}`];
    }
    return validateValue(params, { ...this.parameters, type: "object" }, "");
  }

  toSchema(): ToolSchema {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }
}
