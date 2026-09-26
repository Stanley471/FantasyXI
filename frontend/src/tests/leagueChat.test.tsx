import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  chatSocketUrl,
  dropDeliveredDrafts,
  formatMessageTime,
  mergeMessages,
  reconnectDelay,
  MAX_CHAT_MESSAGE_LENGTH,
} from "../lib/chat";
import { ChatMessageList } from "../components/chat/ChatMessageList";
import { ChatComposer } from "../components/chat/ChatComposer";
import { LeagueChat } from "../components/chat/LeagueChat";
import type { ChatEntry } from "../types";

function msg(id: string, createdAt: string, extra: Partial<ChatEntry> = {}): ChatEntry {
  return {
    id,
    leagueId: "league-1",
    userId: "alice",
    username: "alice",
    body: `message ${id}`,
    createdAt,
    ...extra,
  };
}

const draft = (clientId: string, body: string, extra: Partial<ChatEntry> = {}): ChatEntry =>
  msg(clientId, "2026-09-26T12:00:00.000Z", { clientId, body, status: "sending", ...extra });

describe("Chat helpers", () => {
  it("derives the WebSocket URL from the API base URL", () => {
    assert.equal(chatSocketUrl("http://localhost:5000", "abc"), "ws://localhost:5000/api/v1/leagues/abc/chat/ws");
    assert.equal(chatSocketUrl("https://api.fantasyxi.app", "a b"), "wss://api.fantasyxi.app/api/v1/leagues/a%20b/chat/ws");
  });

  it("merges history and live messages without duplicates, oldest first", () => {
    const merged = mergeMessages(
      [msg("b", "2026-09-26T12:00:02Z"), msg("a", "2026-09-26T12:00:01Z")],
      [msg("c", "2026-09-26T12:00:03Z"), msg("a", "2026-09-26T12:00:01Z")]
    );
    assert.deepEqual(merged.map((m) => m.id), ["a", "b", "c"]);
  });

  it("orders messages with identical timestamps deterministically", () => {
    const merged = mergeMessages([], [msg("y", "2026-09-26T12:00:00Z"), msg("x", "2026-09-26T12:00:00Z")]);
    assert.deepEqual(merged.map((m) => m.id), ["x", "y"]);
  });

  it("replaces an optimistic message with the acknowledged one", () => {
    const withDraft = mergeMessages([msg("a", "2026-09-26T12:00:01Z")], [draft("c-1", "hello")]);
    assert.deepEqual(withDraft.map((m) => m.status ?? "saved"), ["saved", "sending"]);

    const acked = mergeMessages(withDraft, [msg("srv-1", "2026-09-26T12:00:05Z", { clientId: "c-1", body: "hello" })]);
    assert.deepEqual(acked.map((m) => m.id), ["a", "srv-1"]);
    assert.ok(acked.every((m) => !m.status));
  });

  it("does not duplicate a message whose broadcast arrives before its ack", () => {
    let list = mergeMessages([], [draft("c-1", "hello")]);
    list = mergeMessages(list, [msg("srv-1", "2026-09-26T12:00:05Z", { body: "hello" })]); // broadcast
    list = mergeMessages(list, [msg("srv-1", "2026-09-26T12:00:05Z", { body: "hello", clientId: "c-1" })]); // ack
    assert.deepEqual(list.map((m) => m.id), ["srv-1"]);
  });

  it("keeps unsent messages below confirmed ones", () => {
    const list = mergeMessages([draft("c-1", "pending", { status: "failed" })], [msg("a", "2026-09-26T13:00:00Z")]);
    assert.deepEqual(list.map((m) => m.id), ["a", "c-1"]);
  });

  it("drops drafts lost in flight once re-synced history shows they were saved", () => {
    const lost = draft("c-1", "did this send?", { status: "failed", lostInFlight: true });
    const limited = draft("c-2", "did this send?", { status: "failed" }); // rate limited: never saved
    const saved = msg("srv-1", "2026-09-26T12:00:01Z", { body: "did this send?" });

    const result = dropDeliveredDrafts([saved, lost, limited], "alice");
    assert.deepEqual(result.map((m) => m.id), ["srv-1", "c-2"]);

    // Another user's identical message does not count as delivery
    const other = msg("srv-2", "2026-09-26T12:00:01Z", { body: "did this send?", userId: "bob" });
    assert.deepEqual(dropDeliveredDrafts([other, lost], "alice").map((m) => m.id), ["srv-2", "c-1"]);
  });

  it("matches each saved message to at most one lost draft", () => {
    const saved = msg("srv-1", "2026-09-26T12:00:01Z", { body: "gg" });
    const lostA = draft("c-1", "gg", { status: "failed", lostInFlight: true });
    const lostB = draft("c-2", "gg", { status: "failed", lostInFlight: true });
    assert.deepEqual(dropDeliveredDrafts([saved, lostA, lostB], "alice").map((m) => m.id), ["srv-1", "c-2"]);
  });

  it("backs off exponentially with a cap and bounded jitter", () => {
    assert.deepEqual([0, 1, 2, 3, 4].map((a) => reconnectDelay(a, () => 0)), [1000, 2000, 4000, 8000, 16000]);
    assert.equal(reconnectDelay(10, () => 0), 30_000);
    assert.equal(reconnectDelay(10, () => 1), 36_000);
  });

  it("formats message times relative to now", () => {
    const now = new Date("2026-09-26T18:00:00");
    assert.equal(formatMessageTime(new Date("2026-09-26T14:05:00").toISOString(), now), "14:05");
    assert.equal(formatMessageTime(new Date("2026-09-24T09:30:00").toISOString(), now), "Thu 09:30");
    // en-GB abbreviates September as "Sep" or "Sept" depending on the ICU version
    assert.match(formatMessageTime(new Date("2026-09-12T20:15:00").toISOString(), now), /^12 Sept?, 20:15$/);
  });
});

describe("ChatMessageList", () => {
  const now = new Date("2026-09-26T18:00:00Z");
  const messages: ChatEntry[] = [
    msg("1", "2026-09-26T17:00:00Z", { userId: "bob", username: "bob", body: "Your captain blanked again 😂" }),
    msg("2", "2026-09-26T17:01:00Z", { userId: "bob", username: "bob", body: "<script>alert(1)</script>" }),
    msg("3", "2026-09-26T17:02:00Z", { body: "Line one\nLine two" }),
    draft("c-1", "on its way"),
    draft("c-2", "blocked", { status: "failed", error: "You are sending messages too quickly." }),
  ];
  const html = renderToStaticMarkup(
    <ChatMessageList messages={messages} currentUserId="alice" onRetry={() => {}} now={now} />
  );

  it("is a polite ARIA log", () => {
    assert.match(html, /<ol role="log" aria-live="polite" aria-relevant="additions" aria-label="Chat messages"/);
    assert.equal((html.match(/<li /g) ?? []).length, messages.length);
  });

  it("labels authors once per run of messages, and the viewer as You", () => {
    assert.equal((html.match(/>@bob<\/span>/g) ?? []).length, 1);
    assert.match(html, /<span class="sr-only">@bob: <\/span>/);
    assert.equal((html.match(/>You<\/span>/g) ?? []).length, 1);
  });

  it("renders message bodies as text, never as HTML", () => {
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /whitespace-pre-wrap[^>]*>Line one\nLine two</);
  });

  it("shows timestamps for saved messages and status for unsent ones", () => {
    assert.match(html, /<time dateTime="2026-09-26T17:00:00Z">/);
    assert.match(html, />Sending…<\/span>/);
    assert.match(html, /Not sent: You are sending messages too quickly\./);
    assert.match(html, /<button type="button"[^>]*>Retry<\/button>/);
  });
});

describe("ChatComposer", () => {
  it("has an accessible label and keyboard hint, and starts with Send disabled", () => {
    const html = renderToStaticMarkup(<ChatComposer onSend={() => {}} />);
    assert.match(html, /<label for="([^"]+)" class="sr-only">Message the league<\/label><textarea id="\1"/);
    assert.match(html, new RegExp(`maxLength="${MAX_CHAT_MESSAGE_LENGTH}"`));
    assert.match(html, /aria-describedby="[^"]+"/);
    assert.match(html, /Enter to send · Shift\+Enter for a new line/);
    assert.match(html, /<button type="submit" disabled=""[^>]*>Send<\/button>/);
  });

  it("explains why the chat is unavailable", () => {
    const html = renderToStaticMarkup(
      <ChatComposer onSend={() => {}} disabled disabledReason="Only members of this league can use the chat." />
    );
    assert.match(html, /<textarea[^>]*disabled=""[^>]*placeholder="Only members of this league can use the chat\."/);
  });
});

describe("LeagueChat", () => {
  it("renders the panel with its connection status and an empty state before history loads", () => {
    const html = renderToStaticMarkup(<LeagueChat leagueId="league-1" currentUser={{ id: "alice", username: "alice" }} />);
    assert.match(html, /<section aria-labelledby="league-chat-heading"/);
    assert.match(html, /<h2 id="league-chat-heading"[^>]*>League chat<\/h2>/);
    assert.match(html, /<p role="status"[^>]*>.*Connecting…<\/p>/);
    assert.match(html, /No messages yet\. Get the banter started!/);
    assert.match(html, /tabindex="0" aria-label="Chat history"/);
  });
});
