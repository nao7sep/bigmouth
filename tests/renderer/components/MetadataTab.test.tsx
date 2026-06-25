import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { render, act, cleanup, fireEvent } from "@testing-library/react";
import { createRef } from "react";

// MetadataTab only reaches the network through these three api calls.
vi.mock("@renderer/api", () => ({
  updatePost: vi.fn(),
  generateMetadataField: vi.fn(),
  generateMetadataFields: vi.fn(),
}));

import { MetadataTab, type MetadataTabHandle } from "@renderer/components/MetadataTab";
import { updatePost, generateMetadataFields } from "@renderer/api";
import type { PostFrontMatter, PostMutationResult } from "@shared/types";

const AUTOSAVE_DELAY_MS = 1_000;
const mockUpdatePost = vi.mocked(updatePost);
const mockGenerateMetadataFields = vi.mocked(generateMetadataFields);

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

// A deferred updatePost: each call parks a resolver the test fires later, so a
// save can be held in flight while the user keeps editing.
function deferUpdatePost(resolvers: Array<() => void>) {
  mockUpdatePost.mockImplementation(
    () =>
      new Promise<PostMutationResult>((resolve) => {
        resolvers.push(() => resolve(result()));
      })
  );
}

// Resolve in-flight saves (and any issued later) until `pending` settles. The
// flush drain loop and Generate All issue a variable number of saves, so the
// test resolves whatever is queued rather than a fixed count; re-resolving an
// already-settled promise is a no-op.
async function settleSaves(resolvers: Array<() => void>, pending: Promise<unknown>) {
  let done = false;
  void pending.then(() => {
    done = true;
  });
  for (let guard = 0; !done && guard < 100; guard += 1) {
    resolvers.forEach((resolve) => resolve());
    await Promise.resolve();
  }
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
  return { ref, container, titleInput };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockUpdatePost.mockReset();
  mockGenerateMetadataFields.mockReset();
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

  it("does not drop an edit made while Generate All's batch save is in flight", async () => {
    const resolvers: Array<() => void> = [];
    deferUpdatePost(resolvers);
    // Generation returns immediately with a value for every English field.
    mockGenerateMetadataFields.mockResolvedValue({
      title: { value: "GenTitle" },
      slug: { value: "GenSlug" },
      tags: { value: "GenTags" },
      metaDescription: { value: "GenDesc" },
    });

    const { ref, container, titleInput } = renderTab();
    const generateAll = container.querySelector(".btn-generate-all") as HTMLButtonElement;

    await act(async () => {
      fireEvent.click(generateAll);
      // Wait until the batch save is actually issued (generation resolved and
      // setFields ran), then edit the Title before that save resolves.
      for (let i = 0; i < 50 && mockUpdatePost.mock.calls.length < 1; i += 1) {
        await Promise.resolve();
      }
      fireEvent.change(titleInput, { target: { value: "User Edit" } });
      resolvers[0]();
    });

    // The batch save recorded the generated Title, but the field now holds the
    // user's newer value, so it must stay dirty and a flush must persist it —
    // the unconditional dirty-clear in the old batch path would have lost it.
    let flushed: boolean | undefined;
    await act(async () => {
      const pending = ref.current!.flushPendingChanges();
      await settleSaves(resolvers, pending);
      flushed = await pending;
    });

    expect(flushed).toBe(true);
    expect(mockUpdatePost.mock.calls.at(-1)?.[1]).toEqual({
      frontMatter: { title: "User Edit" },
    });
  });

  it("flush keeps saving until no field is dirty when an edit lands mid-flush", async () => {
    const resolvers: Array<() => void> = [];
    deferUpdatePost(resolvers);
    const { ref, titleInput } = renderTab();

    fireEvent.change(titleInput, { target: { value: "A" } });

    let flushed: boolean | undefined;
    await act(async () => {
      // flushPendingChanges issues the save of "A" synchronously; edit to "B"
      // before it resolves so the field is dirty again when the save lands. The
      // drain loop must notice and persist "B" before reporting success.
      const pending = ref.current!.flushPendingChanges();
      fireEvent.change(titleInput, { target: { value: "B" } });
      await settleSaves(resolvers, pending);
      flushed = await pending;
    });

    expect(flushed).toBe(true);
    expect(mockUpdatePost).toHaveBeenCalledTimes(2);
    expect(mockUpdatePost.mock.calls.at(-1)?.[1]).toEqual({ frontMatter: { title: "B" } });
  });
});
