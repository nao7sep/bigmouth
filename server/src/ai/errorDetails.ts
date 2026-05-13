import { error as logError, formatLogValue, logBlock } from "../services/logger.js";

type PromptPayload = {
  systemPrompt: string;
  userContent: string;
};

type AiFailureContext = {
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

export function describeAiError(err: unknown): string {
  if (err instanceof Error) {
    const record = getErrorRecord(err);
    const details: string[] = [`message=${err.message}`];

    const status = record?.status;
    if (typeof status === "number") details.push(`status=${status}`);

    const type =
      typeof record?.type === "string"
        ? record.type
        : record?.error &&
            typeof record.error === "object" &&
            typeof (record.error as Record<string, unknown>).type === "string"
          ? ((record.error as Record<string, unknown>).type as string)
          : null;
    if (type) details.push(`type=${type}`);

    const requestId =
      typeof record?.requestID === "string"
        ? record.requestID
        : typeof record?._request_id === "string"
          ? record._request_id
          : typeof record?.request_id === "string"
            ? record.request_id
            : null;
    if (requestId) details.push(`requestId=${requestId}`);

    const cause = record?.cause;
    if (cause instanceof Error) {
      details.push(`cause=${cause.message}`);
    }

    if (record?.error !== undefined) {
      details.push(`error=${formatLogValue(record.error)}`);
    }

    return details.join(", ");
  }

  return `message=${String(err)}`;
}

export function logAiFailure(
  context: AiFailureContext,
  err: unknown,
  prompt?: PromptPayload,
  rawResponse?: string
): string {
  const details = describeAiError(err);
  const summaryParts = [
    `${context.kind} failure`,
    `requestId=${context.requestId ?? "-"}`,
    `workspace=${context.workspaceId ?? "-"}`,
    `postId=${context.postId ?? "-"}`,
  ];
  if (context.promptName) summaryParts.push(`promptName=${context.promptName}`);
  if (context.field) summaryParts.push(`field=${context.field}`);
  if (context.extra && Object.keys(context.extra).length > 0) {
    summaryParts.push(`extra=${formatLogValue(context.extra)}`);
  }
  summaryParts.push(details);
  logError(summaryParts.join(", "));

  if (prompt) {
    logBlock(
      "ERROR",
      `${context.kind} system prompt: requestId=${context.requestId ?? "-"}, postId=${context.postId ?? "-"}`,
      prompt.systemPrompt
    );
    logBlock(
      "ERROR",
      `${context.kind} user content: requestId=${context.requestId ?? "-"}, postId=${context.postId ?? "-"}`,
      prompt.userContent
    );
  }

  if (rawResponse !== undefined) {
    logBlock(
      "ERROR",
      `${context.kind} raw response: requestId=${context.requestId ?? "-"}, postId=${context.postId ?? "-"}, rawLength=${rawResponse.length}`,
      rawResponse
    );
  }

  return details;
}
