import type { Workspace } from "@shared/types";
import { ANTHROPIC_ENDPOINT, type AiRole } from "@shared/aiModels";
import { getRoleCall, approveAiEndpoint } from "./storageAccess.js";
import { carryingText } from "@shared/i18n/carriedMessage";
import { message } from "@shared/i18n/translate";

/** Recipient identity includes scheme, host, port and base path. */
export function normalizedAiEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("The AI endpoint must be an HTTP(S) URL without credentials or a fragment.");
  }
  return url.href.replace(/\/+$/, "");
}

/** The approved snapshot is the one sent, even if the workspace file changes while asking. */
export async function authorizedRoleCall(workspace: Workspace, role: AiRole) {
  const call = await getRoleCall(workspace, role);
  const endpoint = normalizedAiEndpoint(call.endpoint);
  if (!call.apiKey || endpoint === normalizedAiEndpoint(ANTHROPIC_ENDPOINT) || workspace.approvedAiEndpoint === endpoint) {
    return { ...call, endpoint };
  }
  const { confirmAiEndpoint } = await import("./dialogs.js");
  if (!await confirmAiEndpoint(endpoint)) throw new Error(carryingText(message("ai.destinationCancelled")));
  await approveAiEndpoint(workspace.id, endpoint);
  return { ...call, endpoint };
}
