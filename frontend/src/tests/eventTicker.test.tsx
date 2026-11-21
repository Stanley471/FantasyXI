import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEventTickerStore } from "@/store/eventTickerStore";
import EventTickerCard from "@/components/live/EventTickerCard";
import type { TimelineEvent } from "@/types";

// Mock event data
const createMockEvent = (overrides?: Partial<TimelineEvent>): TimelineEvent => ({
  id: "evt-" + Math.random().toString(36).slice(2),
  fixtureId: 1,
  fixtureName: "Arsenal vs Liverpool",
  gameweekId: 1,
  playerId: 100,
  fplId: 100,
  playerName: "Test Player",
  teamShortName: "ARS",
  teamId: 1,
  type: "GOAL",
  minute: 45,
  detail: "Left foot finish",
  pointsAwarded: 5,
  timestamp: new Date().toISOString(),
  ...overrides,
});

describe("EventTickerCard", () => {
  it("renders event with icon and details", () => {
    const event = createMockEvent();
    render(
      <EventTickerCard
        event={event}
        autoRemoveAfterMs={10000}
      />
    );

    expect(screen.getByText("Test Player")).toBeInTheDocument();
    expect(screen.getByText("(ARS)")).toBeInTheDocument();
    expect(screen.getByText("45'")).toBeInTheDocument();
    expect(screen.getByText("+5 pts")).toBeInTheDocument();
  });

  it("highlights user squad events", () => {
    const event = createMockEvent();
    const { container } = render(
      <EventTickerCard
        event={event}
        isInUserTeam={true}
        autoRemoveAfterMs={10000}
      />
    );

    const cardElement = container.firstChild;
    expect(cardElement).toHaveClass("from-emerald-950/80");
  });

  it("shows captain badge", () => {
    const event = createMockEvent();
    render(
      <EventTickerCard
        event={event}
        isInUserTeam={true}
        isCaptain={true}
        autoRemoveAfterMs={10000}
      />
    );

    expect(screen.getByText("C")).toBeInTheDocument();
  });

  it("shows vice captain badge", () => {
    const event = createMockEvent();
    render(
      <EventTickerCard
        event={event}
        isInUserTeam={true}
        isViceCaptain={true}
        autoRemoveAfterMs={10000}
      />
    );

    expect(screen.getByText("V")).toBeInTheDocument();
  });

  it("displays correct points for negative points", () => {
    const event = createMockEvent({ pointsAwarded: -1 });
    render(
      <EventTickerCard
        event={event}
        autoRemoveAfterMs={10000}
      />
    );

    expect(screen.getByText("-1 pts")).toBeInTheDocument();
  });

  it("handles event dismissal", async () => {
    const handleRemove = vi.fn();
    const event = createMockEvent();
    render(
      <EventTickerCard
        event={event}
        onRemove={handleRemove}
        autoRemoveAfterMs={10000}
      />
    );

    const dismissButton = screen.getByLabelText("Dismiss event");
    await userEvent.click(dismissButton);

    await waitFor(() => {
      expect(handleRemove).toHaveBeenCalledWith(event.id);
    });
  });

  it("auto-removes after timeout", async () => {
    const handleRemove = vi.fn();
    const event = createMockEvent();
    vi.useFakeTimers();

    render(
      <EventTickerCard
        event={event}
        onRemove={handleRemove}
        autoRemoveAfterMs={1000}
      />
    );

    vi.advanceTimersByTime(1300);

    await waitFor(() => {
      expect(handleRemove).toHaveBeenCalledWith(event.id);
    });

    vi.useRealTimers();
  });

  it("renders different event types with correct icons", () => {
    const eventTypes = [
      { type: "GOAL" as const, label: "Goal" },
      { type: "ASSIST" as const, label: "Assist" },
      { type: "YELLOW_CARD" as const, label: "Yellow Card" },
      { type: "RED_CARD" as const, label: "Red Card" },
      { type: "SAVE" as const, label: "Save" },
      { type: "BONUS" as const, label: "Bonus" },
    ];

    for (const { type, label } of eventTypes) {
      const event = createMockEvent({ type });
      const { unmount } = render(
        <EventTickerCard
          event={event}
          autoRemoveAfterMs={10000}
        />
      );

      expect(screen.getByText(label)).toBeInTheDocument();
      unmount();
    }
  });
});

describe("EventTickerStore", () => {
  beforeEach(() => {
    // Reset store state between tests
    useEventTickerStore.setState({
      eventQueue: [],
      filterMode: "ALL",
      mySquadPlayerIds: new Set(),
      connectionState: "closed",
      lastError: null,
    });
  });

  it("adds events to queue", () => {
    const { getState } = useEventTickerStore;
    const event1 = createMockEvent({ id: "1" });
    const event2 = createMockEvent({ id: "2" });

    getState().addEvent(event1);
    expect(getState().eventQueue).toHaveLength(1);
    expect(getState().eventQueue[0].id).toBe("1");

    getState().addEvent(event2);
    expect(getState().eventQueue).toHaveLength(2);
    expect(getState().eventQueue[0].id).toBe("2"); // Most recent first
  });

  it("prevents duplicate events by ID", () => {
    const { getState } = useEventTickerStore;
    const event = createMockEvent({ id: "1" });

    getState().addEvent(event);
    getState().addEvent(event); // Add same event again

    expect(getState().eventQueue).toHaveLength(1);
  });

  it("bounds queue size", () => {
    const { getState } = useEventTickerStore;
    getState().setMaxQueueSize(5);

    for (let i = 0; i < 10; i++) {
      getState().addEvent(createMockEvent({ id: `evt-${i}` }));
    }

    expect(getState().eventQueue).toHaveLength(5);
  });

  it("removes event by ID", () => {
    const { getState } = useEventTickerStore;
    const event1 = createMockEvent({ id: "1" });
    const event2 = createMockEvent({ id: "2" });

    getState().addEvent(event1);
    getState().addEvent(event2);
    expect(getState().eventQueue).toHaveLength(2);

    getState().removeEvent("1");
    expect(getState().eventQueue).toHaveLength(1);
    expect(getState().eventQueue[0].id).toBe("2");
  });

  it("clears all events", () => {
    const { getState } = useEventTickerStore;
    getState().addEvent(createMockEvent({ id: "1" }));
    getState().addEvent(createMockEvent({ id: "2" }));

    expect(getState().eventQueue).toHaveLength(2);
    getState().clearEvents();
    expect(getState().eventQueue).toHaveLength(0);
  });

  describe("filtering", () => {
    beforeEach(() => {
      const { getState } = useEventTickerStore;
      getState().setMySquadPlayerIds([100, 101]);

      // Add mixed events
      getState().addEvent(createMockEvent({ id: "1", playerId: 100, type: "GOAL" }));
      getState().addEvent(createMockEvent({ id: "2", playerId: 200, type: "GOAL" }));
      getState().addEvent(createMockEvent({ id: "3", playerId: 100, type: "SAVE" }));
      getState().addEvent(createMockEvent({ id: "4", playerId: 200, type: "YELLOW_CARD" }));
    });

    it("filters ALL mode returns all events", () => {
      const { getState } = useEventTickerStore;
      getState().setFilterMode("ALL");

      const filtered = getState().getFilteredEvents();
      expect(filtered).toHaveLength(4);
    });

    it("filters MY_SQUAD mode returns only user squad events", () => {
      const { getState } = useEventTickerStore;
      getState().setFilterMode("MY_SQUAD");

      const filtered = getState().getFilteredEvents();
      expect(filtered).toHaveLength(2);
      expect(filtered.every((e) => [100, 101].includes(e.playerId))).toBe(true);
    });

    it("filters FANTASY_RELEVANT mode returns only fantasy-relevant events", () => {
      const { getState } = useEventTickerStore;
      getState().setFilterMode("FANTASY_RELEVANT");

      const filtered = getState().getFilteredEvents();
      expect(filtered.length).toBeGreaterThan(0);
      const relevantTypes = ["GOAL", "ASSIST", "YELLOW_CARD", "RED_CARD", "BONUS", "SAVE"];
      expect(filtered.every((e) => relevantTypes.includes(e.type))).toBe(true);
    });
  });

  it("tracks connection state", () => {
    const { getState } = useEventTickerStore;

    expect(getState().connectionState).toBe("closed");

    getState().setConnectionState("connecting");
    expect(getState().connectionState).toBe("connecting");

    getState().setConnectionState("open");
    expect(getState().connectionState).toBe("open");

    getState().setConnectionState("reconnecting");
    expect(getState().connectionState).toBe("reconnecting");
  });

  it("tracks errors", () => {
    const { getState } = useEventTickerStore;
    const error = new Error("Test error");

    expect(getState().lastError).toBeNull();

    getState().setLastError(error);
    expect(getState().lastError).toBe(error);

    getState().setLastError(null);
    expect(getState().lastError).toBeNull();
  });
});

describe("Event Ticker Queue Deduplication", () => {
  it("deduplicates rapid burst of events", () => {
    const { getState } = useEventTickerStore;
    const baseEvent = createMockEvent({ id: "burst-1" });

    // Simulate socket burst with duplicate IDs (can happen from queue replay)
    for (let i = 0; i < 5; i++) {
      getState().addEvent(baseEvent);
    }

    expect(getState().eventQueue).toHaveLength(1);
  });

  it("handles out-of-order event arrivals", () => {
    const { getState } = useEventTickerStore;

    const event1 = createMockEvent({ id: "1", minute: 45 });
    const event2 = createMockEvent({ id: "2", minute: 30 });
    const event3 = createMockEvent({ id: "3", minute: 60 });

    getState().addEvent(event1);
    getState().addEvent(event2);
    getState().addEvent(event3);

    // Should be in reverse order (most recent first in queue)
    expect(getState().eventQueue[0].id).toBe("3");
    expect(getState().eventQueue[1].id).toBe("1");
    expect(getState().eventQueue[2].id).toBe("2");
  });
});

describe("Event Ticker Connection Lifecycle", () => {
  it("initializes with closed connection", () => {
    const { getState } = useEventTickerStore;
    expect(getState().connectionState).toBe("closed");
  });

  it("tracks connection state transitions", () => {
    const { getState } = useEventTickerStore;
    const stateTransitions: Array<string> = [];

    const unsubscribe = useEventTickerStore.subscribe((state) => {
      stateTransitions.push(state.connectionState);
    });

    getState().setConnectionState("connecting");
    getState().setConnectionState("open");
    getState().setConnectionState("reconnecting");
    getState().setConnectionState("closed");

    unsubscribe();

    expect(stateTransitions.length).toBeGreaterThan(0);
  });
});
