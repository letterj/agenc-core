import { describe, expect, it } from "vitest";

import { InMemoryBackend } from "../memory/in-memory/backend.js";
import {
  appendTranscriptBatch,
  createTranscriptHistorySnapshotEvent,
  createTranscriptMessageEvent,
  createTranscriptMetadataProjectionEvent,
  forkTranscript,
  historyFromTranscript,
  loadTranscript,
} from "./session-transcript.js";

describe("session transcript adapter", () => {
  it("round-trips transcript events through transcript-capable backends", async () => {
    const backend = new InMemoryBackend();

    await appendTranscriptBatch(backend, "session-1", [
      createTranscriptMessageEvent({
        surface: "webchat",
        message: { role: "user", content: "hello" },
        dedupeKey: "user-1",
      }),
      createTranscriptMetadataProjectionEvent({
        surface: "webchat",
        key: "session.metadata",
        value: { shellProfile: "general" },
        dedupeKey: "meta-1",
      }),
      createTranscriptHistorySnapshotEvent({
        surface: "webchat",
        history: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
        reason: "compaction",
        dedupeKey: "snapshot-1",
      }),
      createTranscriptMessageEvent({
        surface: "webchat",
        message: { role: "assistant", content: "post-compact" },
        dedupeKey: "assistant-1",
      }),
    ]);

    const transcript = await loadTranscript(backend, "session-1");
    expect(transcript).toBeDefined();
    expect(transcript?.events.map((event) => event.kind)).toEqual([
      "message",
      "metadata_projection",
      "history_snapshot",
      "message",
    ]);
    expect(historyFromTranscript(transcript)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "assistant", content: "post-compact" },
    ]);
  });

  it("forks transcript streams without reusing event ids", async () => {
    const backend = new InMemoryBackend();

    await appendTranscriptBatch(backend, "source", [
      createTranscriptMessageEvent({
        surface: "text",
        message: { role: "user", content: "fork me" },
      }),
    ]);

    expect(await forkTranscript(backend, "source", "target")).toBe(true);

    const source = await loadTranscript(backend, "source");
    const target = await loadTranscript(backend, "target");
    expect(historyFromTranscript(target)).toEqual(historyFromTranscript(source));
    expect(target?.events[0]?.eventId).not.toBe(source?.events[0]?.eventId);
  });
});
