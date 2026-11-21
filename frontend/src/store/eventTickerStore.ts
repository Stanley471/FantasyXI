import { create } from "zustand";
import type { TimelineEvent } from "@/types";

interface EventTickerState {
  // Queue of events to display
  eventQueue: TimelineEvent[];
  addEvent: (event: TimelineEvent) => void;
  removeEvent: (eventId: string) => void;
  clearEvents: () => void;

  // Filter settings
  filterMode: "ALL" | "MY_SQUAD" | "FANTASY_RELEVANT";
  setFilterMode: (mode: "ALL" | "MY_SQUAD" | "FANTASY_RELEVANT") => void;

  // My squad player IDs for filtering
  mySquadPlayerIds: Set<number>;
  setMySquadPlayerIds: (ids: number[]) => void;

  // Display settings
  maxQueueSize: number;
  setMaxQueueSize: (size: number) => void;

  // Connection state
  connectionState: "connecting" | "open" | "reconnecting" | "closed";
  setConnectionState: (state: "connecting" | "open" | "reconnecting" | "closed") => void;

  // Error tracking
  lastError: Error | null;
  setLastError: (error: Error | null) => void;

  // Get filtered events based on current filter mode
  getFilteredEvents: () => TimelineEvent[];
}

/**
 * Event ticker store manages the queue of live match events,
 * filtering, and connection state. Handles deduplication via eventQueue uniqueness.
 */
export const useEventTickerStore = create<EventTickerState>((set, get) => ({
  eventQueue: [],
  addEvent: (event: TimelineEvent) => {
    set((state) => {
      // Prevent duplicates by event ID
      if (state.eventQueue.some((e) => e.id === event.id)) {
        return state;
      }

      // Keep queue bounded
      const newQueue = [event, ...state.eventQueue];
      if (newQueue.length > state.maxQueueSize) {
        newQueue.pop();
      }

      return { eventQueue: newQueue };
    });
  },

  removeEvent: (eventId: string) => {
    set((state) => ({
      eventQueue: state.eventQueue.filter((e) => e.id !== eventId),
    }));
  },

  clearEvents: () => {
    set({ eventQueue: [] });
  },

  filterMode: "ALL",
  setFilterMode: (mode: "ALL" | "MY_SQUAD" | "FANTASY_RELEVANT") => {
    set({ filterMode: mode });
  },

  mySquadPlayerIds: new Set(),
  setMySquadPlayerIds: (ids: number[]) => {
    set({ mySquadPlayerIds: new Set(ids) });
  },

  maxQueueSize: 50,
  setMaxQueueSize: (size: number) => {
    set({ maxQueueSize: Math.max(10, size) });
  },

  connectionState: "closed",
  setConnectionState: (state: "connecting" | "open" | "reconnecting" | "closed") => {
    set({ connectionState: state });
  },

  lastError: null,
  setLastError: (error: Error | null) => {
    set({ lastError: error });
  },

  getFilteredEvents: () => {
    const state = get();
    const { eventQueue, filterMode, mySquadPlayerIds } = state;

    if (filterMode === "ALL") {
      return eventQueue;
    }

    if (filterMode === "MY_SQUAD") {
      return eventQueue.filter((e) => mySquadPlayerIds.has(e.playerId));
    }

    if (filterMode === "FANTASY_RELEVANT") {
      // Fantasy-relevant events: GOAL, ASSIST, YELLOW_CARD, RED_CARD, BONUS, SAVE
      const relevantTypes = new Set(["GOAL", "ASSIST", "YELLOW_CARD", "RED_CARD", "BONUS", "SAVE"]);
      return eventQueue.filter((e) => relevantTypes.has(e.type));
    }

    return eventQueue;
  },
}));
