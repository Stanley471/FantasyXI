/**
 * Integration tests for optimistic squad mutations with automatic rollback.
 * Tests Issue #520: optimistic UI updates for player swap, captain selection,
 * and vice-captain selection with server error handling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useTeamStore, LocalSquadPlayer } from "@/store/teamStore";
import { api, ApiError } from "@/lib/api";
import { Player, Position, SQUAD_RULES } from "@/types";

// Mock API
vi.mock("@/lib/api", () => ({
  api: {
    put: vi.fn(),
    post: vi.fn(),
  },
  ApiError: class ApiError extends Error {
    constructor(status: number, message: string, data?: unknown) {
      super(message);
      this.status = status;
      this.data = data;
    }
    status: number;
    data: unknown;
  },
}));

// Mock toast notifications
vi.mock("@/context/ToastContext", () => ({
  emitToast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock navigator.onLine
Object.defineProperty(window.navigator, "onLine", {
  writable: true,
  value: true,
});

describe("Optimistic Squad Mutations", () => {
  const mockPlayer1: Player = {
    id: 1,
    firstName: "John",
    lastName: "Doe",
    displayName: "J. Doe",
    position: Position.DEF,
    teamId: 1,
    price: 500,
    status: "available",
    news: null,
    imageUrl: null,
    totalPoints: 100,
  };

  const mockPlayer2: Player = {
    id: 2,
    firstName: "Jane",
    lastName: "Smith",
    displayName: "J. Smith",
    position: Position.MID,
    teamId: 2,
    price: 700,
    status: "available",
    news: null,
    imageUrl: null,
    totalPoints: 120,
  };

  const mockPlayer3: Player = {
    id: 3,
    firstName: "Bob",
    lastName: "Johnson",
    displayName: "B. Johnson",
    position: Position.FWD,
    teamId: 3,
    price: 800,
    status: "available",
    news: null,
    imageUrl: null,
    totalPoints: 150,
  };

  const createLocalSquadPlayer = (
    player: Player,
    idx: number,
    overrides?: Partial<LocalSquadPlayer>
  ): LocalSquadPlayer => ({
    playerId: player.id,
    player,
    isStarter: true,
    isCaptain: idx === 0,
    isViceCaptain: idx === 1,
    positionOrder: idx + 1,
    ...overrides,
  });

  beforeEach(() => {
    // Reset store
    useTeamStore.setState({
      players: [],
      squadId: "test-squad-123",
      squadName: "Test Squad",
      selectedPlayerId: null,
      optimisticState: {
        isOptimistic: false,
        mutationId: null,
        previousState: null,
      },
    });
    vi.clearAllMocks();
    navigator.onLine = true;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Player Swap", () => {
    it("should optimistically swap players and apply changes immediately", async () => {
      const player1 = createLocalSquadPlayer(mockPlayer1, 0);
      const player2 = createLocalSquadPlayer(mockPlayer2, 1);
      const player3 = createLocalSquadPlayer(mockPlayer3, 2, { isStarter: false });

      useTeamStore.setState({
        players: [player1, player2, player3],
      });

      vi.mocked(api.put).mockResolvedValue({ success: true, data: {} });

      const store = useTeamStore.getState();
      const result = await store.handleSwapOptimistic(
        mockPlayer1.id,
        mockPlayer2.id,
        "test-squad-123",
        "2024-01-01T00:00:00Z"
      );

      expect(result).toBe(true);

      // Verify swap happened optimistically
      const updatedStore = useTeamStore.getState();
      const swappedPlayer1 = updatedStore.players.find((p) => p.playerId === mockPlayer1.id);
      const swappedPlayer2 = updatedStore.players.find((p) => p.playerId === mockPlayer2.id);

      expect(swappedPlayer1?.positionOrder).toBe(2);
      expect(swappedPlayer2?.positionOrder).toBe(1);

      // Verify API was called
      expect(api.put).toHaveBeenCalledWith(
        "/api/v1/squads/test-squad-123",
        expect.objectContaining({
          expectedUpdatedAt: "2024-01-01T00:00:00Z",
        })
      );

      // Optimistic state should be cleared after successful server response
      expect(updatedStore.optimisticState.isOptimistic).toBe(false);
    });

    it("should rollback swap on server 500 error", async () => {
      const player1 = createLocalSquadPlayer(mockPlayer1, 0);
      const player2 = createLocalSquadPlayer(mockPlayer2, 1);
      const player3 = createLocalSquadPlayer(mockPlayer3, 2, { isStarter: false });

      const originalPlayers = [player1, player2, player3];
      useTeamStore.setState({ players: [...originalPlayers] });

      const error = new ApiError(500, "Internal Server Error");
      vi.mocked(api.put).mockRejectedValue(error);

      const store = useTeamStore.getState();
      const result = await store.handleSwapOptimistic(
        mockPlayer1.id,
        mockPlayer2.id,
        "test-squad-123",
        "2024-01-01T00:00:00Z"
      );

      expect(result).toBe(false);

      // Verify players were rolled back
      const updatedStore = useTeamStore.getState();
      const restoredPlayer1 = updatedStore.players.find((p) => p.playerId === mockPlayer1.id);
      const restoredPlayer2 = updatedStore.players.find((p) => p.playerId === mockPlayer2.id);

      expect(restoredPlayer1?.positionOrder).toBe(1);
      expect(restoredPlayer2?.positionOrder).toBe(2);

      // Optimistic state should be cleared
      expect(updatedStore.optimisticState.isOptimistic).toBe(false);
    });

    it("should rollback swap on server 409 conflict error", async () => {
      const player1 = createLocalSquadPlayer(mockPlayer1, 0);
      const player2 = createLocalSquadPlayer(mockPlayer2, 1);
      const player3 = createLocalSquadPlayer(mockPlayer3, 2, { isStarter: false });

      const originalPlayers = [player1, player2, player3];
      useTeamStore.setState({ players: [...originalPlayers] });

      const error = new ApiError(409, "Conflict: revision mismatch", {
        data: { revision: "newer-revision" },
      });
      vi.mocked(api.put).mockRejectedValue(error);

      const store = useTeamStore.getState();
      const result = await store.handleSwapOptimistic(
        mockPlayer1.id,
        mockPlayer2.id,
        "test-squad-123",
        "old-revision"
      );

      expect(result).toBe(false);

      // Verify players were rolled back
      const updatedStore = useTeamStore.getState();
      expect(updatedStore.players).toEqual(originalPlayers);
      expect(updatedStore.optimisticState.isOptimistic).toBe(false);
    });

    it("should rollback swap on server 403 forbidden (deadline passed)", async () => {
      const player1 = createLocalSquadPlayer(mockPlayer1, 0);
      const player2 = createLocalSquadPlayer(mockPlayer2, 1);

      const originalPlayers = [player1, player2];
      useTeamStore.setState({ players: [...originalPlayers] });

      const error = new ApiError(403, "Squad locked: deadline passed", {
        deadline: "2024-01-01T15:00:00Z",
      });
      vi.mocked(api.put).mockRejectedValue(error);

      const store = useTeamStore.getState();
      const result = await store.handleSwapOptimistic(
        mockPlayer1.id,
        mockPlayer2.id,
        "test-squad-123"
      );

      expect(result).toBe(false);

      // Verify rollback
      const updatedStore = useTeamStore.getState();
      expect(updatedStore.players[0].playerId).toBe(mockPlayer1.id);
      expect(updatedStore.players[1].playerId).toBe(mockPlayer2.id);
    });

    it("should not swap if players not found", async () => {
      const player1 = createLocalSquadPlayer(mockPlayer1, 0);
      useTeamStore.setState({ players: [player1] });

      const store = useTeamStore.getState();
      const result = await store.handleSwapOptimistic(
        999,
        999,
        "test-squad-123"
      );

      expect(result).toBe(false);
      expect(api.put).not.toHaveBeenCalled();
    });
  });

  describe("Captain Selection", () => {
    it("should optimistically set captain and sync with server", async () => {
      const player1 = createLocalSquadPlayer(mockPlayer1, 0, { isCaptain: false });
      const player2 = createLocalSquadPlayer(mockPlayer2, 1, { isCaptain: true });
      const player3 = createLocalSquadPlayer(mockPlayer3, 2);

      useTeamStore.setState({ players: [player1, player2, player3] });
      vi.mocked(api.put).mockResolvedValue({ success: true, data: {} });

      const store = useTeamStore.getState();
      const result = await store.handleSetCaptainOptimistic(
        mockPlayer1.id,
        "test-squad-123",
        "2024-01-01T00:00:00Z"
      );

      expect(result).toBe(true);

      // Verify captain was changed optimistically
      const updatedStore = useTeamStore.getState();
      const newCaptain = updatedStore.players.find((p) => p.playerId === mockPlayer1.id);
      const oldCaptain = updatedStore.players.find((p) => p.playerId === mockPlayer2.id);

      expect(newCaptain?.isCaptain).toBe(true);
      expect(oldCaptain?.isCaptain).toBe(false);
      expect(updatedStore.optimisticState.isOptimistic).toBe(false);
    });

    it("should rollback captain selection on server error", async () => {
      const player1 = createLocalSquadPlayer(mockPlayer1, 0, { isCaptain: false });
      const player2 = createLocalSquadPlayer(mockPlayer2, 1, { isCaptain: true });

      const originalPlayers = [player1, player2];
      useTeamStore.setState({ players: [...originalPlayers] });

      const error = new ApiError(500, "Internal Server Error");
      vi.mocked(api.put).mockRejectedValue(error);

      const store = useTeamStore.getState();
      const result = await store.handleSetCaptainOptimistic(
        mockPlayer1.id,
        "test-squad-123"
      );

      expect(result).toBe(false);

      // Verify captain selection was rolled back
      const updatedStore = useTeamStore.getState();
      const restoredCaptain = updatedStore.players.find(
        (p) => p.playerId === mockPlayer2.id
      );
      const restored = updatedStore.players.find((p) => p.playerId === mockPlayer1.id);

      expect(restoredCaptain?.isCaptain).toBe(true);
      expect(restored?.isCaptain).toBe(false);
    });
  });

  describe("Vice-Captain Selection", () => {
    it("should optimistically set vice-captain and sync with server", async () => {
      const player1 = createLocalSquadPlayer(mockPlayer1, 0);
      const player2 = createLocalSquadPlayer(mockPlayer2, 1, { isViceCaptain: false });
      const player3 = createLocalSquadPlayer(mockPlayer3, 2, { isViceCaptain: true });

      useTeamStore.setState({ players: [player1, player2, player3] });
      vi.mocked(api.put).mockResolvedValue({ success: true, data: {} });

      const store = useTeamStore.getState();
      const result = await store.handleSetViceCaptainOptimistic(
        mockPlayer2.id,
        "test-squad-123",
        "2024-01-01T00:00:00Z"
      );

      expect(result).toBe(true);

      // Verify vice-captain was changed optimistically
      const updatedStore = useTeamStore.getState();
      const newViceCaptain = updatedStore.players.find(
        (p) => p.playerId === mockPlayer2.id
      );
      const oldViceCaptain = updatedStore.players.find(
        (p) => p.playerId === mockPlayer3.id
      );

      expect(newViceCaptain?.isViceCaptain).toBe(true);
      expect(oldViceCaptain?.isViceCaptain).toBe(false);
      expect(updatedStore.optimisticState.isOptimistic).toBe(false);
    });

    it("should rollback vice-captain selection on server error", async () => {
      const player1 = createLocalSquadPlayer(mockPlayer1, 0);
      const player2 = createLocalSquadPlayer(mockPlayer2, 1, { isViceCaptain: false });
      const player3 = createLocalSquadPlayer(mockPlayer3, 2, { isViceCaptain: true });

      const originalPlayers = [player1, player2, player3];
      useTeamStore.setState({ players: [...originalPlayers] });

      const error = new ApiError(403, "Squad locked");
      vi.mocked(api.put).mockRejectedValue(error);

      const store = useTeamStore.getState();
      const result = await store.handleSetViceCaptainOptimistic(
        mockPlayer2.id,
        "test-squad-123"
      );

      expect(result).toBe(false);

      // Verify vice-captain selection was rolled back
      const updatedStore = useTeamStore.getState();
      expect(updatedStore.players.find((p) => p.playerId === mockPlayer3.id)?.isViceCaptain).toBe(true);
      expect(updatedStore.players.find((p) => p.playerId === mockPlayer2.id)?.isViceCaptain).toBe(false);
    });
  });

  describe("Offline Behavior", () => {
    it("should queue mutations for offline sync when offline", async () => {
      navigator.onLine = false;
      const player1 = createLocalSquadPlayer(mockPlayer1, 0);
      const player2 = createLocalSquadPlayer(mockPlayer2, 1);

      useTeamStore.setState({ players: [player1, player2] });

      const store = useTeamStore.getState();
      const result = await store.handleSwapOptimistic(
        mockPlayer1.id,
        mockPlayer2.id,
        "test-squad-123"
      );

      // Should return true because local state is updated
      expect(result).toBe(true);
      // API should not be called when offline
      expect(api.put).not.toHaveBeenCalled();

      navigator.onLine = true;
    });
  });

  describe("Rapid Mutation Atomicity", () => {
    it("should queue mutations atomically when performed rapidly", async () => {
      const players = [
        createLocalSquadPlayer(mockPlayer1, 0),
        createLocalSquadPlayer(mockPlayer2, 1),
        createLocalSquadPlayer(mockPlayer3, 2),
      ];
      useTeamStore.setState({ players });

      vi.mocked(api.put).mockResolvedValue({ success: true, data: {} });

      const store = useTeamStore.getState();

      // Perform two mutations rapidly
      const swap1 = store.handleSwapOptimistic(mockPlayer1.id, mockPlayer2.id, "test-squad-123");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const setCaptain = store.handleSetCaptainOptimistic(mockPlayer3.id, "test-squad-123");

      const [result1, result2] = await Promise.all([swap1, setCaptain]);

      expect(result1).toBe(true);
      expect(result2).toBe(true);

      // Both mutations should be reflected
      const updatedStore = useTeamStore.getState();
      const captain = updatedStore.players.find((p) => p.isCaptain);
      expect(captain?.playerId).toBe(mockPlayer3.id);
    });

    it("should rollback all mutations if final mutation fails", async () => {
      const players = [
        createLocalSquadPlayer(mockPlayer1, 0),
        createLocalSquadPlayer(mockPlayer2, 1),
        createLocalSquadPlayer(mockPlayer3, 2),
      ];
      useTeamStore.setState({ players });

      let callCount = 0;
      vi.mocked(api.put).mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new ApiError(409, "Conflict");
        }
        return { success: true, data: {} };
      });

      const store = useTeamStore.getState();

      // First mutation should succeed
      const swap1 = store.handleSwapOptimistic(
        mockPlayer1.id,
        mockPlayer2.id,
        "test-squad-123"
      );
      const result1 = await swap1;
      expect(result1).toBe(true);

      // Second mutation should fail and trigger rollback
      const setCaptain = store.handleSetCaptainOptimistic(
        mockPlayer3.id,
        "test-squad-123"
      );
      const result2 = await setCaptain;
      expect(result2).toBe(false);

      // Captain should be rolled back
      const updatedStore = useTeamStore.getState();
      const captain = updatedStore.players.find((p) => p.isCaptain);
      expect(captain?.playerId).toBe(mockPlayer1.id);
    });
  });

  describe("State Consistency", () => {
    it("should maintain consistent state during optimistic updates", async () => {
      const players = [
        createLocalSquadPlayer(mockPlayer1, 0),
        createLocalSquadPlayer(mockPlayer2, 1),
        createLocalSquadPlayer(mockPlayer3, 2),
      ];
      useTeamStore.setState({ players });

      vi.mocked(api.put).mockResolvedValue({ success: true, data: {} });

      const store = useTeamStore.getState();
      await store.handleSwapOptimistic(mockPlayer1.id, mockPlayer2.id, "test-squad-123");

      const updatedStore = useTeamStore.getState();

      // Verify no duplicate players
      const playerIds = new Set(updatedStore.players.map((p) => p.playerId));
      expect(playerIds.size).toBe(3);

      // Verify all players still exist
      expect(updatedStore.players.length).toBe(3);

      // Verify positionOrder is still valid
      const orders = updatedStore.players.map((p) => p.positionOrder).sort();
      expect(orders).toEqual([1, 2, 3]);
    });
  });
});
