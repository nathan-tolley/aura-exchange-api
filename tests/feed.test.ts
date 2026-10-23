import { describe, expect, it } from "vitest";
import { serializeFeedEvent, type FeedRow } from "../src/services/feed-service.js";

const row: FeedRow = {
  id: "event", kind: "AURA_RULING", actor_id: "author", subject_stock_id: "target",
  payload: { authorId: "author", delta: 3, explanation: "Did the thing" }, created_at: new Date(),
  actor_name: "Alex Author", actor_ticker: "ALEX", subject_name: "Taylor Target", subject_ticker: "TAYL"
};

describe("feed anonymity", () => {
  it("removes identity for ordinary viewers", () => {
    const event = serializeFeedEvent(row, { role: "MEMBER", stockId: "someone-else" });
    expect(event.actor.displayName).toBe("Anonymous");
    expect(event.payload).not.toHaveProperty("authorId");
  });

  it("reveals identity to the subject", () => {
    const event = serializeFeedEvent(row, { role: "MEMBER", stockId: "target" });
    expect(event.actor.displayName).toBe("Alex Author");
    expect(event.payload.authorId).toBe("author");
  });

  it("reveals identity to moderators", () => {
    const event = serializeFeedEvent(row, { role: "MODERATOR", stockId: null });
    expect(event.actor.displayName).toBe("Alex Author");
  });
});

