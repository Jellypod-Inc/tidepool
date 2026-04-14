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
  logWireFailure(opts.mode, opts.context, issueSummary);

  if (opts.mode === "warn") {
    return { ok: true, data: data as z.infer<S> };
  }
  return { ok: false, error: issueSummary };
}

/**
 * Single source of truth for the `[wire-validation]` log line format. Callers
 * outside `validateWire` (e.g. the SSE proxy reporting a non-schema failure
 * like invalid JSON) should use this helper so operators see a uniform prefix
 * and grep pattern regardless of which layer detected the problem.
 */
export function logWireFailure(
  mode: ValidationMode,
  context: string,
  detail: string,
): void {
  console.warn(`[wire-validation] ${mode} ${context} — ${detail}`);
}
