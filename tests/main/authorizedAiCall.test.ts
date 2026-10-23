import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "@shared/types";
import type { RoleCall } from "@main/core/services/configStore.js";
import { ANTHROPIC_ENDPOINT } from "@shared/aiModels";

const storage = vi.hoisted(() => ({ getRoleCall: vi.fn(), approveAiEndpoint: vi.fn() }));
const dialogs = vi.hoisted(() => ({ confirmAiEndpoint: vi.fn() }));
vi.mock("@main/storageAccess.js", () => storage);
vi.mock("@main/dialogs.js", () => dialogs);

import { authorizedRoleCall } from "@main/authorizedAiCall.js";

let workspace: Workspace;
let backingCall: RoleCall;

beforeEach(() => {
  vi.resetAllMocks();
  workspace = { id: "workspace", name: "Test", dataDirectory: "/unused" };
  backingCall = { endpoint: ANTHROPIC_ENDPOINT, apiKey: "test-key", model: "test-model", thinking: "adaptive" };
  storage.getRoleCall.mockImplementation(async () => backingCall);
  storage.approveAiEndpoint.mockResolvedValue(undefined);
  dialogs.confirmAiEndpoint.mockResolvedValue(true);
});

describe("AI destination approval", () => {
  it("returns the default Anthropic call without asking or persisting approval", async () => {
    await expect(authorizedRoleCall(workspace, "analysis")).resolves.toEqual(backingCall);
    expect(storage.getRoleCall).toHaveBeenCalledWith(workspace, "analysis");
    expect(dialogs.confirmAiEndpoint).not.toHaveBeenCalled();
    expect(storage.approveAiEndpoint).not.toHaveBeenCalled();
  });

  it("persists the normalized destination and returns the snapshot shown during approval", async () => {
    backingCall = { ...backingCall, endpoint: " https://CUSTOM.example:443/base/// " };
    const captured = { ...backingCall, endpoint: "https://custom.example/base" };
    dialogs.confirmAiEndpoint.mockImplementation(async () => {
      // A different config/key becomes current while the confirmation is open.
      backingCall = { endpoint: "https://other.example/new", apiKey: "different-key", model: "other-model", thinking: "off" };
      return true;
    });
    await expect(authorizedRoleCall(workspace, "metadata")).resolves.toEqual(captured);
    expect(dialogs.confirmAiEndpoint).toHaveBeenCalledExactlyOnceWith(captured.endpoint);
    expect(storage.approveAiEndpoint).toHaveBeenCalledExactlyOnceWith(workspace.id, captured.endpoint);
    expect(storage.getRoleCall).toHaveBeenCalledTimes(1);
  });

  it("rejects refusal without persisting approval or allowing the request", async () => {
    backingCall.endpoint = "https://custom.example/base";
    dialogs.confirmAiEndpoint.mockResolvedValue(false);
    const request = vi.fn();
    await expect(authorizedRoleCall(workspace, "analysis").then(request)).rejects.toThrow();
    expect(storage.approveAiEndpoint).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    "https://other.example/base",
    "http://custom.example/base",
    "https://custom.example/different",
    "https://custom.example:8443/base",
  ])("asks again for the changed recipient %s", async (endpoint) => {
    workspace.approvedAiEndpoint = "https://custom.example/base";
    backingCall.endpoint = endpoint;
    await expect(authorizedRoleCall(workspace, "analysis")).resolves.toMatchObject({ endpoint });
    expect(dialogs.confirmAiEndpoint).toHaveBeenCalledExactlyOnceWith(endpoint);
    expect(storage.approveAiEndpoint).toHaveBeenCalledExactlyOnceWith(workspace.id, endpoint);
  });

  it("skips confirmation when the exact normalized destination was approved", async () => {
    workspace.approvedAiEndpoint = "https://custom.example/base";
    backingCall.endpoint = "https://CUSTOM.example:443/base/";
    await expect(authorizedRoleCall(workspace, "analysis")).resolves.toMatchObject({ endpoint: workspace.approvedAiEndpoint });
    expect(dialogs.confirmAiEndpoint).not.toHaveBeenCalled();
    expect(storage.approveAiEndpoint).not.toHaveBeenCalled();
  });

  it.each([
    "https://user:password@custom.example/base",
    "https://user@custom.example/base",
    "https://custom.example/base#fragment",
    "file:///tmp/endpoint",
    "ftp://custom.example/base",
    "not a URL",
  ])("rejects invalid destination %s before asking or allowing a request", async (endpoint) => {
    backingCall.endpoint = endpoint;
    const request = vi.fn();
    await expect(authorizedRoleCall(workspace, "analysis").then(request)).rejects.toThrow();
    expect(dialogs.confirmAiEndpoint).not.toHaveBeenCalled();
    expect(storage.approveAiEndpoint).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects failed approval persistence before allowing the request", async () => {
    backingCall.endpoint = "https://custom.example/base";
    const failure = new Error("Could not persist approval");
    storage.approveAiEndpoint.mockRejectedValue(failure);
    const request = vi.fn();
    await expect(authorizedRoleCall(workspace, "analysis").then(request)).rejects.toBe(failure);
    expect(dialogs.confirmAiEndpoint).toHaveBeenCalledExactlyOnceWith(backingCall.endpoint);
    expect(storage.approveAiEndpoint).toHaveBeenCalledExactlyOnceWith(workspace.id, backingCall.endpoint);
    expect(request).not.toHaveBeenCalled();
  });
});
