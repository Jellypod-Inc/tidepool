import { v4 as uuidv4 } from "uuid";

export interface A2AErrorResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: {
    id: string;
    status: { state: string };
    artifacts: Array<{
      artifactId: string;
      parts: Array<{ kind: string; text: string }>;
    }>;
  };
}

function buildErrorResponse(
  statusCode: number,
  state: string,
  message: string,
  headers: Record<string, string> = {},
  taskId?: string,
): A2AErrorResponse {
  return {
    statusCode,
    headers,
    body: {
      // When a caller's messageId is available, echo it so clients can
      // correlate the error to the request that triggered it. Fall back to
      // a fresh uuid when we have nothing to correlate to (e.g. malformed
      // request bodies or early-rejected requests without a parsed body).
      id: taskId ?? uuidv4(),
      status: { state },
      artifacts: [
        {
          artifactId: "error",
          parts: [{ kind: "text", text: message }],
        },
      ],
    },
  };
}

export function rateLimitResponse(
  retryAfterSeconds: number,
  taskId?: string,
): A2AErrorResponse {
  return buildErrorResponse(
    429,
    "failed",
    `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
    { "Retry-After": String(retryAfterSeconds) },
    taskId,
  );
}

export function notFriendResponse(taskId?: string): A2AErrorResponse {
  return buildErrorResponse(
    403,
    "rejected",
    "You are not authorized. Send a CONNECTION_REQUEST to establish a friendship first.",
    {},
    taskId,
  );
}

export function agentNotFoundResponse(
  tenant: string,
  taskId?: string,
): A2AErrorResponse {
  return buildErrorResponse(
    404,
    "failed",
    `Agent "${tenant}" not found on this server.`,
    {},
    taskId,
  );
}

export function agentScopeDeniedResponse(
  tenant: string,
  taskId?: string,
): A2AErrorResponse {
  return buildErrorResponse(
    403,
    "rejected",
    `You are not authorized to access agent "${tenant}".`,
    {},
    taskId,
  );
}

export function agentTimeoutResponse(
  tenant: string,
  timeoutSeconds: number,
  taskId?: string,
): A2AErrorResponse {
  return buildErrorResponse(
    504,
    "failed",
    `Agent "${tenant}" did not respond within ${timeoutSeconds} seconds.`,
    {},
    taskId,
  );
}

export function malformedRequestResponse(
  detail: string,
  taskId?: string,
): A2AErrorResponse {
  return buildErrorResponse(
    400,
    "failed",
    `Malformed A2A message: ${detail}`,
    {},
    taskId,
  );
}

// ----- Structured error responses (new taxonomy per 2026-04-17 design) -----

export interface StructuredErrorResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: { error: { code: string; message: string; hint?: string } };
}

export interface A2AJsonRpcErrorResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: {
    jsonrpc: "2.0";
    error: { code: number; message: string; data?: unknown };
    id: string;
  };
}

export function structuredError(
  statusCode: number,
  code: string,
  message: string,
  hint?: string,
): StructuredErrorResponse {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: { error: { code, message, ...(hint ? { hint } : {}) } },
  };
}

export function originDeniedResponse(origin: string): StructuredErrorResponse {
  return structuredError(
    403,
    "origin_denied",
    `Origin not allowed: ${origin}`,
    "Only localhost origins may access the tidepool local interface.",
  );
}

export function peerNotFoundResponse(handle: string): StructuredErrorResponse {
  return structuredError(
    404,
    "peer_not_found",
    `No peer named "${handle}" is in friends.`,
    "Call GET /.well-known/tidepool/peers to list reachable peers.",
  );
}

export function sessionConflictResponse(name: string): StructuredErrorResponse {
  return structuredError(
    409,
    "session_conflict",
    `Agent "${name}" already has an active session.`,
    "Another adapter process is registered as this agent. Use `tidepool status` to inspect.",
  );
}

export function peerUnreachableResponse(handle: string): StructuredErrorResponse {
  return structuredError(
    502,
    "peer_unreachable",
    `Peer "${handle}" did not accept the connection.`,
    "The peer's daemon may be offline or unreachable over the network.",
  );
}

export function agentOfflineResponse(handle: string): StructuredErrorResponse {
  return structuredError(
    503,
    "agent_offline",
    `Agent "${handle}" is not currently registered.`,
    "The agent's adapter may have crashed or not yet started.",
  );
}

export function peerTimeoutResponse(
  handle: string,
  timeoutSeconds: number,
): StructuredErrorResponse {
  return structuredError(
    504,
    "peer_timeout",
    `Peer "${handle}" did not respond within ${timeoutSeconds} seconds.`,
    "The peer may be slow or unreachable. Retry if transient.",
  );
}

export function unsupportedOperationResponse(
  method: string,
  messageId: string,
): A2AJsonRpcErrorResponse {
  return {
    statusCode: 405,
    headers: { "Content-Type": "application/json" },
    body: {
      jsonrpc: "2.0",
      error: {
        code: -32006,
        message: `Operation not supported: ${method}. This tidepool instance is prose-only and does not implement task methods.`,
      },
      id: messageId,
    },
  };
}
