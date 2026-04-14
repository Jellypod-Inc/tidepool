import type { ZodTypeAny, z } from "zod";

export type ValidationMode = "warn" | "enforce";

export type ValidateWireResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

interface ValidateWireOpts {
  mode: ValidationMode;
  context: string;
}

/**
 * Single entry point for schema validation at wire boundaries. In `warn` mode,
 * validation failures are logged but the raw payload flows through unchanged,
 * letting operators observe non-conforming peers without breaking interop. In
 * `enforce` mode, failures short-circuit the caller (HTTP 400 or failed stream
 * event).
 */
export function validateWire<S extends ZodTypeAny>(
  schema: S,
  data: unknown,
  opts: ValidateWireOpts,
): ValidateWireResult<z.infer<S>> {
  const parsed = schema.safeParse(data);
  if (parsed.success) {
    return { ok: true, data: parsed.data };
  }

  const issueSummary = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  const line = `[wire-validation] ${opts.mode} ${opts.context} — ${issueSummary}`;
  console.warn(line);

  if (opts.mode === "warn") {
    return { ok: true, data: data as z.infer<S> };
  }
  return { ok: false, error: issueSummary };
}
