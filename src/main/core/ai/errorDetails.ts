import { error as logError, serializeError, type LogFields } from "../services/logger.js";

export type AiFailureContext = {
  kind: string;
  requestId?: string;
  workspaceId?: string;
  postId?: string;
  promptName?: string;
  field?: string;
  extra?: Record<string, unknown>;
};

function getErrorRecord(err: unknown): Record<string, unknown> | null {
  return err && typeof err === "object" ? (err as Record<string, unknown>) : null;
}

/**
 * Structured description of an AI/provider failure. Builds on the canonical error
 * serialization (type, message, stack, cause chain) and adds the provider-specific
 * fields the Anthropic SDK attaches: HTTP status, error type, provider request id,
 * and the nested error payload. Returned as fields to merge into a log record —
 * never a rendered string.
 */
export function describeAiError(err: unknown): Record<string, unknown> {
  const details: Record<string, unknown> = { error: serializeError(err) };

  const record = getErrorRecord(err);
  if (!record) return details;

  const status = record.status;
  if (typeof status === "number") details.status = status;

  const type =
    typeof record.type === "string"
      ? record.type
      : record.error &&
          typeof record.error === "object" &&
          typeof (record.error as Record<string, unknown>).type === "string"
        ? ((record.error as Record<string, unknown>).type as string)
        : undefined;
  if (type) details.providerErrorType = type;

  const providerRequestId =
    typeof record.requestID === "string"
      ? record.requestID
      : typeof record._request_id === "string"
        ? record._request_id
        : typeof record.request_id === "string"
          ? record.request_id
          : undefined;
  if (providerRequestId) details.providerRequestId = providerRequestId;

  if (record.error !== undefined) details.providerError = record.error;

  return details;
}

/**
 * Short, human-readable message for a failure, used as the HTTP fallback. Errors
 * surface their own `.message` at the call site; this covers the non-Error case.
 */
export function aiErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Logs an AI/provider failure as one structured `error` record and returns a
 * short message suitable for the HTTP response. When the provider returns
 * unparseable free-form output, that output is captured in a single `rawResponse`
 * field (newlines JSON-escaped, so the event stays one physical line) — never a
 * multi-line block.
 */
export function logAiFailure(
  context: AiFailureContext,
  err: unknown,
  rawResponse?: string
): string {
  const fields: LogFields = {
    requestId: context.requestId ?? null,
    workspaceId: context.workspaceId ?? null,
    postId: context.postId ?? null,
    ...(context.promptName ? { promptName: context.promptName } : {}),
    ...(context.field ? { field: context.field } : {}),
    ...(context.extra ?? {}),
    ...describeAiError(err),
  };

  if (rawResponse !== undefined) {
    fields.rawResponse = rawResponse;
    fields.rawResponseLength = rawResponse.length;
  }

  logError(`${context.kind} failed`, fields);
  return aiErrorMessage(err);
}
