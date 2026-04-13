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
): A2AErrorResponse {
  return {
    statusCode,
    headers,
    body: {
      id: uuidv4(),
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
): A2AErrorResponse {
  return buildErrorResponse(
    429,
    "TASK_STATE_FAILED",
    `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
    { "Retry-After": String(retryAfterSeconds) },
  );
}

export function notFriendResponse(): A2AErrorResponse {
  return buildErrorResponse(
    403,
    "TASK_STATE_REJECTED",
    "You are not authorized. Send a CONNECTION_REQUEST to establish a friendship first.",
  );
}

export function agentNotFoundResponse(tenant: string): A2AErrorResponse {
  return buildErrorResponse(
    404,
    "TASK_STATE_FAILED",
    `Agent "${tenant}" not found on this server.`,
  );
}

export function agentScopeDeniedResponse(tenant: string): A2AErrorResponse {
  return buildErrorResponse(
    403,
    "TASK_STATE_REJECTED",
    `You are not authorized to access agent "${tenant}".`,
  );
}

export function agentTimeoutResponse(
  tenant: string,
  timeoutSeconds: number,
): A2AErrorResponse {
  return buildErrorResponse(
    504,
    "TASK_STATE_FAILED",
    `Agent "${tenant}" did not respond within ${timeoutSeconds} seconds.`,
  );
}
