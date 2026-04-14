import type { ZodTypeAny, z } from "zod";

// Minimal structural shape of a zod v4 issue. We only depend on the two
// fields we format against, plus the `invalid_union` sub-errors array — this
// keeps us decoupled from zod's deep type exports, which differ between the
// classic and core re-exports.
type ZodIssueLike = {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly code?: string;
  readonly errors?: readonly (readonly ZodIssueLike[])[];
};

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
    .map((i) => summarizeIssue(i as unknown as ZodIssueLike, data))
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

/** Format a single issue as `path: message`. Used for non-union issues. */
function formatIssue(issue: ZodIssueLike): string {
  const path = issue.path.map(String).join(".") || "(root)";
  return `${path}: ${issue.message}`;
}

/**
 * Format a zod issue, peeling one level deeper when it's a union failure.
 *
 * zod v4 reports `invalid_union` at the top level of the ancestor path with
 * `issue.errors: $ZodIssue[][]` holding per-variant sub-issues. Surfacing
 * only the top-level "Invalid input" message is useless for operators — they
 * need to know WHICH variant was closest and what specifically failed inside
 * it. We:
 *
 *   1. If the input carries a `kind` property, prefer the variant whose
 *      sub-issues don't complain about `kind` — that variant's discriminator
 *      matched, so its field errors are the meaningful ones.
 *   2. Otherwise, pick the variant with the fewest sub-issues as the
 *      "closest match" — a heuristic, but far more informative than the
 *      opaque generic message.
 *
 * The chosen variant's errors are formatted and prefixed with a `[variant …]`
 * tag (using the discriminator kind when available, else the 1-based index)
 * so operators can quickly see which shape the validator leaned toward.
 */
function summarizeIssue(issue: ZodIssueLike, input: unknown): string {
  if (issue.code !== "invalid_union" || !issue.errors || issue.errors.length === 0) {
    return formatIssue(issue);
  }

  const variants = issue.errors;
  const inputKind = getKind(input);

  let chosenIdx = -1;
  if (inputKind !== undefined) {
    // Pick the first variant whose issues do NOT reference the `kind` path —
    // meaning that variant's discriminator matched the input.
    chosenIdx = variants.findIndex(
      (v) => !v.some((sub) => sub.path[0] === "kind"),
    );
  }
  if (chosenIdx === -1) {
    // Fall back to the variant with the fewest issues (closest match).
    let min = Infinity;
    variants.forEach((v, idx) => {
      if (v.length > 0 && v.length < min) {
        min = v.length;
        chosenIdx = idx;
      }
    });
  }
  if (chosenIdx === -1) {
    // All variant buckets empty — nothing to drill into; fall back.
    return formatIssue(issue);
  }

  const chosen = variants[chosenIdx]!;
  const tag = inputKind !== undefined ? `variant ${inputKind}` : `variant ${chosenIdx + 1}`;
  const inner = chosen.map((sub) => formatIssue(sub)).join("; ");
  return `[${tag}] ${inner}`;
}

function getKind(input: unknown): string | undefined {
  if (input && typeof input === "object" && "kind" in input) {
    const k = (input as { kind?: unknown }).kind;
    if (typeof k === "string") return k;
  }
  return undefined;
}
