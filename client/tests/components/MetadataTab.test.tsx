import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { createRef } from "react";

// MetadataTab only reaches the network through these three api calls.
vi.mock("../../src/api", () => ({
  updatePost: vi.fn(),
  generateMetadataField: vi.fn(),
  generateMetadataFields: vi.fn(),
}));

import { MetadataTab, type MetadataTabHandle } from "../../src/components/MetadataTab";
import { updatePost } from "../../src/api";
import type { PostFrontMatter, PostMutationResult } from "../../src/types";

const AUTOSAVE_DELAY_MS = 1_000;
const mockUpdatePost = vi.mocked(updatePost);

function frontMatter(): PostFrontMatter {
  return {
    id: "p1",
    target: "blog",
    status: "draft",
    language: "en",
    createdAtUtc: "2024-01-01T00:00:00.000Z",
    title: "",
  };
}

function result(): PostMutationResult {
  const fm = frontMatter();
  return { frontMatter: fm, content: "", summary: fm };
}

function renderTab() {
  const ref = createRef<MetadataTabHandle>();
  const onPostUpdated = vi.fn();
  const { container } = render(
    <MetadataTab
      ref={ref}
      workspaceId="w1"
      postId="p1"
      frontMatter={frontMatter()}
      content="some body text"
      extraFieldWatermark=""
      onPostUpdated={onPostUpdated}
    />
  );
  // The Title field is the first textarea rendered.
  const titleInput = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
  return { ref, titleInput };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockUpdatePost.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("MetadataTab autosave", () => {
  it("persists a field edit after the debounce", async () => {
    mockUpdatePost.mockResolvedValue(result());
    const { titleInput } = renderTab();

    fireEvent.change(titleInput, { target: { value: "Hello" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });

    expect(mockUpdatePost).toHaveBeenCalledWith("p1", { frontMatter: { title: "Hello" } }, "w1");
  });

  it("does not lose a newer edit when an older save resolves mid-flight before flush", async () => {
    // Make each save controllable so the first save can stay in flight while the
    // user edits again.
    const resolvers: Array<() => void> = [];
    mockUpdatePost.mockImplementation(() => {
      return new Promise<PostMutationResult>((resolve) => {
        resolvers.push(() => resolve(result()));
      });
    });

    const { ref, titleInput } = renderTab();

    // Type "A" and let its debounce fire — save A is now in flight.
    fireEvent.change(titleInput, { target: { value: "A" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS);
    });
    expect(resolvers).toHaveLength(1);

    // Edit to "B" before A's save resolves and before B's debounce fires.
    fireEvent.change(titleInput, { target: { value: "B" } });

    // The stale "A" save resolves. It must NOT clear the dirty flag, because the
    // field already holds the newer "B".
    await act(async () => {
      resolvers[0]();
    });

    // Switching posts flushes: it cancels B's pending timer, so flush itself must
    // persist the newer "B".
    let flushed: boolean | undefined;
    await act(async () => {
      const pending = ref.current!.flushPendingChanges();
      resolvers[1]?.(); // resolve the flush's save of "B"
      flushed = await pending;
    });

    expect(flushed).toBe(true);
    expect(mockUpdatePost).toHaveBeenCalledTimes(2);
    expect(mockUpdatePost.mock.calls.at(-1)?.[1]).toEqual({ frontMatter: { title: "B" } });
  });
});
