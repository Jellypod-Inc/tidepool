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
    .map((i) => summarizeIssue(i as unknown as ZodIssueLike, data, schema))
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
 *
 * The `detail` argument is sanitized to escape C0 control characters and DEL
 * so adversarial upstream bytes cannot overstrike prior log lines, inject
 * ANSI escape sequences, or corrupt structured log ingestion. The `mode` and
 * `context` arguments are code-authored constants and are emitted verbatim.
 */
export function logWireFailure(
  mode: ValidationMode,
  context: string,
  detail: string,
): void {
  const safe = sanitizeForLog(detail);
  console.warn(`[wire-validation] ${mode} ${context} — ${safe}`);
}

/**
 * Replace every C0 control character (0x00–0x1F) and DEL (0x7F) with its
 * `\xNN` escape. Leaves normal printable characters (including high Unicode)
 * untouched, so legitimate payload content remains human-readable in logs.
 */
function sanitizeForLog(s: string): string {
  return s.replace(/[\x00-\x1F\x7F]/g, (ch) => {
    const code = ch.charCodeAt(0);
    return `\\x${code.toString(16).padStart(2, "0")}`;
  });
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
 * it.
 *
 * Variant selection heuristic:
 *
 *   1. Skip variants that declared a `kind` literal but whose literal did
 *      NOT match the input (they complain at `path[0] === "kind"`).
 *   2. Among remaining candidates, pick the one with fewest issues.
 *   3. Tag the chosen variant with the input's `kind` string ONLY when schema
 *      introspection confirms some union variant actually declared that kind
 *      literal. Otherwise use the 0-based variant index — prevents the false
 *      tag `[variant unknownKind]` when the closest match is a kind-less
 *      variant (e.g. Message/Task inside StreamEventSchema).
 */
function summarizeIssue(
  issue: ZodIssueLike,
  input: unknown,
  rootSchema?: unknown,
): string {
  if (issue.code !== "invalid_union" || !issue.errors || issue.errors.length === 0) {
    return formatIssue(issue);
  }

  const variants = issue.errors;
  const inputKind = getKind(input);

  // A variant complains at path[0] === "kind" when its declared kind literal
  // did not match the input. We skip these — they aren't what the peer meant.
  const hasKindMismatch = (v: readonly ZodIssueLike[]): boolean =>
    v.some((sub) => sub.path[0] === "kind");

  const candidates = variants
    .map((v, idx) => ({ idx, issues: v }))
    .filter(({ issues }) => !hasKindMismatch(issues));

  let chosenIdx = -1;

  if (candidates.length > 0) {
    // Pick the candidate with the fewest issues as the closest match.
    const best = candidates.reduce((a, b) =>
      a.issues.length <= b.issues.length ? a : b,
    );
    chosenIdx = best.idx;
  } else {
    // Every variant complained about kind (or all empty) — fall back to
    // fewest non-empty issues across all variants.
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

  // Use the input's kind as a human-friendly tag ONLY when the schema
  // actually declares a variant with that kind literal. This prevents
  // misleading tags like `[variant bogus]` when the input carries an unknown
  // kind and we land on a kind-less fallback variant.
  const kindDeclared =
    inputKind !== undefined && unionDeclaresKindLiteral(rootSchema, inputKind);
  const chosen = variants[chosenIdx]!;
  const tag = kindDeclared ? `variant ${inputKind}` : `variant ${chosenIdx}`;
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

/**
 * Return true if `schema` is a union whose variants include at least one
 * z.object with a `kind: z.literal(<kind>)` field. Uses structural field
 * access on zod's internal `_def` so it tolerates shape changes between zod
 * minor versions: any mismatch simply returns false (falling back to the
 * index-based tag), which is safe.
 */
function unionDeclaresKindLiteral(schema: unknown, kind: string): boolean {
  if (!schema || typeof schema !== "object") return false;
  // Accept both `schema._def.options` (zod classic) and `schema._zod.def.options`
  // (zod v4 core). Either way we're reading a plain options array.
  const def =
    (schema as { _def?: { options?: unknown } })._def ??
    (schema as { _zod?: { def?: { options?: unknown } } })._zod?.def;
  const options = (def as { options?: unknown } | undefined)?.options;
  if (!Array.isArray(options)) return false;
  for (const variant of options) {
    if (!variant || typeof variant !== "object") continue;
    const vDef =
      (variant as { _def?: { shape?: unknown } })._def ??
      (variant as { _zod?: { def?: { shape?: unknown } } })._zod?.def;
    const shape = (vDef as { shape?: unknown } | undefined)?.shape;
    if (!shape || typeof shape !== "object") continue;
    const kindField = (shape as Record<string, unknown>).kind;
    if (!kindField || typeof kindField !== "object") continue;
    const kDef =
      (kindField as { _def?: { values?: unknown } })._def ??
      (kindField as { _zod?: { def?: { values?: unknown } } })._zod?.def;
    const values = (kDef as { values?: unknown } | undefined)?.values;
    if (Array.isArray(values) && values.includes(kind)) return true;
  }
  return false;
}
