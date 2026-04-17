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
