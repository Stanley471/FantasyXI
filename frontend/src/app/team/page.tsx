"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { api, ApiError } from "@/lib/api";
import { isOfflineError, loadSquadSnapshot, saveSquadSnapshot } from "@/lib/offlineStore";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { Squad, Player, Position, SQUAD_RULES } from "@/types";
import { Pitch } from "@/components/pitch/Pitch";
import { Bench } from "@/components/pitch/Bench";
import { BudgetBar } from "@/components/team/BudgetBar";
import { PlayerPickerModal } from "@/components/team/PlayerPickerModal";
import { validateCompleteSquad, detectFormation } from "@/lib/formation";
import {
  IconFootball,
  IconCheck,
  IconAlertCircle,
  IconSwap,
  IconPlus,
} from "@/components/ui/Icons";
import { Button } from "@/components/ui/Button";
import { PositionBadge } from "@/components/ui/Badge";
import { useToast } from "@/context/ToastContext";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";

import { useTeamStore, LocalSquadPlayer } from "@/store/teamStore";
import { PlayerCard } from "@/components/pitch/PlayerCard";

export default function TeamPage() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();
  const { toast } = useToast();

  const { 
    squadId, setSquadId, 
    squadName, setSquadName, 
    players, setPlayers, 
    selectedPlayerId, setSelectedPlayerId,
    activeModalState, setActiveModalState,
    handleSwap, handleSetCaptain, handleSetViceCaptain
  } = useTeamStore();

  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isOnline = useOnlineStatus();
  // When set, the pitch shows the squad saved on this device at that time
  const [offlineSnapshotAt, setOfflineSnapshotAt] = useState<string | null>(null);
  const showingSnapshot = useRef(false);
  const userId = user?.id;

  // Load existing squad
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.replace("/login?returnTo=/team");
      return;
    }
    if (!isAuthenticated || !userId) return;

    let cancelled = false;

    const applySquads = (squads: Squad[]) => {
      if (squads.length === 0) return;
      const s = squads[0];
      setSquadId(s.id);
      setSquadName(s.name);

      if (s.players && s.players.length > 0) {
        const mapped: LocalSquadPlayer[] = s.players
          .filter((sp) => sp.player)
          .map((sp) => ({
            id: sp.id,
            playerId: sp.playerId,
            player: sp.player!,
            isStarter: sp.isStarter,
            isCaptain: sp.isCaptain,
            isViceCaptain: sp.isViceCaptain,
            positionOrder: sp.positionOrder,
          }));
        setPlayers(mapped);
      }
    };

    async function loadSquad() {
      setIsLoading(true);
      try {
        const res = await api.get<{ success: boolean; data: Squad[] }>("/api/v1/squads/me");
        if (cancelled) return;
        if (res?.data) {
          saveSquadSnapshot(userId!, res.data);
          applySquads(res.data);
        }
        showingSnapshot.current = false;
        setOfflineSnapshotAt(null);
      } catch (err) {
        if (cancelled) return;
        const snapshot = isOfflineError(err) ? loadSquadSnapshot(userId!) : null;
        if (snapshot) {
          applySquads(snapshot.squads);
          showingSnapshot.current = true;
          setOfflineSnapshotAt(snapshot.savedAt);
        } else if (isOfflineError(err)) {
          setErrorMessage("You are offline and this device has no saved copy of your squad yet.");
        } else {
          console.error("Failed to load user squad:", err);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadSquad();

    // Swap the saved copy for live data as soon as the connection returns
    const handleOnline = () => {
      if (showingSnapshot.current) {
        setErrorMessage(null);
        loadSquad();
      }
    };
    window.addEventListener("online", handleOnline);
    return () => {
      cancelled = true;
      window.removeEventListener("online", handleOnline);
    };
  }, [isAuthenticated, authLoading, router, userId, setSquadId, setSquadName, setPlayers]);

  // Derived state
  const starters = players
    .filter((p) => p.isStarter)
    .sort((a, b) => a.positionOrder - b.positionOrder);

  const bench = players
    .filter((p) => !p.isStarter)
    .sort((a, b) => a.positionOrder - b.positionOrder);

  const totalSpent = players.reduce((sum, p) => sum + (p.player?.price || 0), 0);
  const remainingBudgetTenths = SQUAD_RULES.STARTING_BUDGET * 10 - totalSpent;

  // Club player counts
  const clubCounts: Record<number, number> = {};
  players.forEach((p) => {
    if (p.player?.teamId) {
      clubCounts[p.player.teamId] = (clubCounts[p.player.teamId] || 0) + 1;
    }
  });

  // Validation
  const validation = validateCompleteSquad(players);
  const canSave = players.length === 15 && validation.valid && totalSpent <= SQUAD_RULES.STARTING_BUDGET * 10;

  // Selected player object
  const selectedPlayer = players.find((p) => p.playerId === selectedPlayerId);

  // DND Handlers
  const [activeDragPlayer, setActiveDragPlayer] = useState<LocalSquadPlayer | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 10,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 250,
        tolerance: 5,
      },
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event;
    const player = players.find((p) => p.playerId === active.id);
    if (player) {
      setActiveDragPlayer(player);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveDragPlayer(null);
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const activeIdNum = Number(active.id);
      const overIdNum = Number(over.id);
      
      if (!isNaN(activeIdNum) && !isNaN(overIdNum)) {
        handleSwap(activeIdNum, overIdNum);
      }
      setSelectedPlayerId(null);
    }
  };

  // Auto-pick balanced squad logic
  const handleAutoPick = async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      // Fetch pool of available players sorted by points
      const res = await api.get<{
        success: boolean;
        data: { players: Player[] } | Player[];
      }>("/api/v1/players?limit=100&sortBy=totalPoints&sortOrder=desc");

      const data = res?.data;
      const pool: Player[] = Array.isArray(data)
        ? data
        : data && typeof data === "object" && "players" in data && Array.isArray((data as { players: Player[] }).players)
          ? (data as { players: Player[] }).players
          : [];

      if (pool.length < 15) {
        setErrorMessage("Not enough players in database to auto-draft a squad.");
        return;
      }

      // Draft: 2 GKP, 5 DEF, 5 MID, 3 FWD, obeying max 3 per club and budget
      const picked: Player[] = [];
      const teamCounts: Record<number, number> = {};

      const pickPosition = (pos: Position, count: number) => {
        const available = pool.filter((p) => p.position === pos);
        let pickedForPos = 0;
        for (const p of available) {
          if (pickedForPos >= count) break;
          const currentCount = teamCounts[p.teamId] || 0;
          if (currentCount < 3) {
            picked.push(p);
            teamCounts[p.teamId] = currentCount + 1;
            pickedForPos++;
          }
        }
      };

      pickPosition(Position.GKP, 2);
      pickPosition(Position.DEF, 5);
      pickPosition(Position.MID, 5);
      pickPosition(Position.FWD, 3);

      if (picked.length === 15) {
        // Starters: 1 GKP, 4 DEF, 4 MID, 2 FWD (standard 4-4-2)
        // Bench: 1 GKP, 1 DEF, 1 MID, 1 FWD
        const gks = picked.filter((p) => p.position === Position.GKP);
        const defs = picked.filter((p) => p.position === Position.DEF);
        const mids = picked.filter((p) => p.position === Position.MID);
        const fwds = picked.filter((p) => p.position === Position.FWD);

        const newPlayers: LocalSquadPlayer[] = [];

        // Starters (11)
        newPlayers.push({
          playerId: gks[0].id,
          player: gks[0],
          isStarter: true,
          isCaptain: false,
          isViceCaptain: false,
          positionOrder: 1,
        });

        defs.slice(0, 4).forEach((p, i) => {
          newPlayers.push({
            playerId: p.id,
            player: p,
            isStarter: true,
            isCaptain: false,
            isViceCaptain: false,
            positionOrder: 2 + i,
          });
        });

        mids.slice(0, 4).forEach((p, i) => {
          newPlayers.push({
            playerId: p.id,
            player: p,
            isStarter: true,
            isCaptain: i === 0, // Make first midfielder Captain
            isViceCaptain: false,
            positionOrder: 6 + i,
          });
        });

        fwds.slice(0, 2).forEach((p, i) => {
          newPlayers.push({
            playerId: p.id,
            player: p,
            isStarter: true,
            isCaptain: false,
            isViceCaptain: i === 0, // Make first forward Vice-Captain
            positionOrder: 10 + i,
          });
        });

        // Bench (4)
        newPlayers.push({
          playerId: gks[1].id,
          player: gks[1],
          isStarter: false,
          isCaptain: false,
          isViceCaptain: false,
          positionOrder: 12,
        });
        newPlayers.push({
          playerId: defs[4].id,
          player: defs[4],
          isStarter: false,
          isCaptain: false,
          isViceCaptain: false,
          positionOrder: 13,
        });
        newPlayers.push({
          playerId: mids[4].id,
          player: mids[4],
          isStarter: false,
          isCaptain: false,
          isViceCaptain: false,
          positionOrder: 14,
        });
        newPlayers.push({
          playerId: fwds[2].id,
          player: fwds[2],
          isStarter: false,
          isCaptain: false,
          isViceCaptain: false,
          positionOrder: 15,
        });

        setPlayers(newPlayers);
        setSelectedPlayerId(null);
        toast.info("Auto-drafted a balanced squad! Review tactics before saving.");
      }
    } catch (err) {
      console.error("Auto-pick error:", err);
      const msg = "Failed to auto-generate squad. Please try picking manually.";
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setIsLoading(false);
    }
  };

  // Click on a player in Pitch or Bench
  const handlePlayerClick = (clickedPlayer: Player | null, position?: Position) => {
    if (!clickedPlayer) {
      // Empty slot clicked -> open picker for this position
      setActiveModalState({
        isOpen: true,
        requiredPosition: position || null,
        replacingPlayer: null,
      });
      return;
    }

    // If another player is already selected, perform swap!
    if (selectedPlayerId && selectedPlayerId !== clickedPlayer.id) {
      handleSwap(selectedPlayerId, clickedPlayer.id);
      setSelectedPlayerId(null);
      return;
    }

    // Otherwise toggle selection
    setSelectedPlayerId(selectedPlayerId === clickedPlayer.id ? null : clickedPlayer.id);
  };

  // Transfer player (replace with someone from picker)
  const handleReplacePlayer = (newPlayer: Player) => {
    const replacing = activeModalState.replacingPlayer;
    if (!replacing) return;

    setPlayers((prev) => {
      const idx = prev.findIndex((p) => p.playerId === replacing.id);
      if (idx === -1) return prev;

      const clone = [...prev];
      clone[idx] = {
        ...clone[idx],
        playerId: newPlayer.id,
        player: newPlayer,
      };
      return clone;
    });

    setSelectedPlayerId(null);
  };

  // Save changes to backend
  const handleSaveSquad = async () => {
    if (!canSave) return;
    if (!isOnline) {
      setErrorMessage("You are offline. Reconnect to save your squad or make transfers.");
      return;
    }
    setIsSaving(true);
    setErrorMessage(null);
    setSaveSuccessMsg(null);

    const payload = {
      name: squadName.trim() || "My Fantasy XI",
      players: players.map((p, idx) => ({
        playerId: p.playerId,
        isStarter: p.isStarter,
        isCaptain: p.isCaptain,
        isViceCaptain: p.isViceCaptain,
        positionOrder: idx + 1,
      })),
    };

    try {
      if (squadId) {
        // Update existing squad
        await api.put(`/api/v1/squads/${squadId}`, payload);
        const msg = "Squad lineup and tactics updated successfully!";
        setSaveSuccessMsg(msg);
        toast.success(msg);
      } else {
        // Create new squad
        const createPayload = {
          ...payload,
          userId: user?.id,
        };
        const res = await api.post<{ success: boolean; data: Squad }>(
          "/api/v1/squads",
          createPayload
        );
        if (res?.data?.id) {
          setSquadId(res.data.id);
        }
        const msg = "Squad created and registered in FantasyXI!";
        setSaveSuccessMsg(msg);
        toast.success(msg);
      }
    } catch (err: unknown) {
      const msg =
        err instanceof ApiError
          ? err.message || "Failed to save squad."
          : err instanceof Error
            ? err.message
            : "An unexpected error occurred while saving squad.";
      setErrorMessage(msg);
      toast.error(msg);
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="py-24 text-center text-slate-400">
        <div className="inline-block w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mb-4" />
        <h2 className="text-base font-bold text-white uppercase tracking-tight">
          Loading Dugout & Tactical Pitch...
        </h2>
        <p className="text-xs text-slate-500 mt-1">Retrieving squad lineup and FPL player telemetry</p>
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="space-y-6 pb-12">
        {/* Top Header & Squad Name */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-pitch-surface border border-pitch-border p-5 rounded-xl shadow-md">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-400">
                Tactical Pitch
              </span>
              <span className="text-xs font-mono text-slate-500">&bull; Gameweek Lineup</span>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={squadName}
                onChange={(e) => setSquadName(e.target.value)}
                placeholder="My Fantasy XI"
                className="text-xl sm:text-2xl font-black text-white bg-transparent border-b border-dashed border-slate-700 hover:border-emerald-400 focus:border-emerald-400 focus:outline-none uppercase tracking-tight"
              />
            </div>
          </div>

          {/* Formation & Rules status */}
          <div className="flex items-center gap-2 text-xs font-mono">
            <span className="text-slate-400 uppercase tracking-wider text-[11px]">Formation</span>
            <span className="text-emerald-400 font-bold text-sm">
              {detectFormation(starters)}
            </span>
          </div>
        </div>

        {/* Offline mode: read-only view of the squad saved on this device */}
        {(offlineSnapshotAt || !isOnline) && (
          <div
            role="status"
            className="p-3.5 rounded-lg bg-amber-950/40 border border-amber-500/40 flex items-center gap-3 text-amber-200 text-xs"
          >
            <IconAlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
            <span className="font-semibold">
              {offlineSnapshotAt
                ? `Offline mode: showing your squad as saved on this device ${new Date(offlineSnapshotAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}.`
                : "You are offline."}{" "}
              Saving and transfers need a connection.
            </span>
          </div>
        )}

        {/* Notifications */}
        {saveSuccessMsg && (
          <div className="p-3.5 rounded-lg bg-emerald-950/40 border border-emerald-500/40 flex items-center gap-3 text-emerald-300 text-xs animate-fadeIn">
            <IconCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <span className="font-semibold">{saveSuccessMsg}</span>
          </div>
        )}

        {errorMessage && (
          <div className="p-3.5 rounded-lg bg-rose-950/40 border border-rose-500/40 flex items-center gap-3 text-rose-300 text-xs animate-shake">
            <IconAlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
            <span className="font-semibold">{errorMessage}</span>
          </div>
        )}

        {/* Budget & Squad Constraints Bar */}
        <BudgetBar
          onAutoPick={handleAutoPick}
          onReset={() => {
            setPlayers([]);
            setSelectedPlayerId(null);
          }}
          isSaving={isSaving}
          onSave={handleSaveSquad}
          canSave={canSave && isOnline}
        />

        {/* Validation Errors Pill if invalid */}
        {!validation.valid && validation.errors.length > 0 && (
          <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-500/30 text-amber-300 text-xs space-y-1">
            <div className="font-bold uppercase tracking-wider flex items-center gap-1.5 text-[11px]">
              <IconAlertCircle className="w-3.5 h-3.5" />
              <span>Lineup Constraints Checklist</span>
            </div>
            <ul className="list-disc list-inside space-y-0.5 text-slate-300">
              {validation.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Action Modal when player is clicked */}
        {selectedPlayer && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-0 bg-slate-950/80 backdrop-blur-sm animate-fadeIn">
            <div className="bg-slate-900 border border-emerald-500/50 shadow-2xl rounded-2xl w-full max-w-sm overflow-hidden animate-slideUp sm:animate-zoomIn">
              <div className="p-5 flex items-center gap-4 border-b border-slate-800 bg-slate-900/50">
                <PositionBadge position={selectedPlayer.player.position} size="md" />
                <div className="flex-1 min-w-0">
                  <div className="text-base font-black text-white truncate uppercase">
                    {selectedPlayer.player.displayName}
                  </div>
                  <div className="text-xs text-slate-400 font-mono mt-0.5">
                    {selectedPlayer.player.team?.shortName || "PL"} &bull; £{(selectedPlayer.player.price / 10).toFixed(1)}m &bull; {selectedPlayer.player.totalPoints} pts
                  </div>
                </div>
              </div>
              <div className="p-4 grid gap-2">
                {selectedPlayer.isStarter && (
                  <>
                    <Button
                      type="button"
                      variant={selectedPlayer.isCaptain ? "primary" : "secondary"}
                      size="md"
                      onClick={() => { handleSetCaptain(selectedPlayer.playerId); setSelectedPlayerId(null); }}
                      className="w-full justify-start text-sm font-bold"
                    >
                      (C) Make Captain
                    </Button>
                    <Button
                      type="button"
                      variant={selectedPlayer.isViceCaptain ? "primary" : "secondary"}
                      size="md"
                      onClick={() => { handleSetViceCaptain(selectedPlayer.playerId); setSelectedPlayerId(null); }}
                      className="w-full justify-start text-sm font-bold"
                    >
                      (V) Make Vice-Captain
                    </Button>
                  </>
                )}
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  onClick={() => {
                    setActiveModalState({
                      isOpen: true,
                      requiredPosition: selectedPlayer.player.position,
                      replacingPlayer: selectedPlayer.player,
                    });
                    setSelectedPlayerId(null);
                  }}
                  className="w-full justify-start text-sm"
                >
                  <IconSwap className="w-4 h-4 mr-2 opacity-70" /> Transfer Out
                </Button>
              </div>
              <div className="p-3 bg-slate-950 border-t border-slate-800">
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  onClick={() => setSelectedPlayerId(null)}
                  className="w-full text-slate-400 hover:text-white"
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Main Pitch View */}
        <Pitch />

        {/* Dugout Substitute Bench */}
        <Bench />

        {/* Transfer & Player Picker Modal */}
        <PlayerPickerModal
          isOpen={activeModalState.isOpen}
          onClose={() =>
            setActiveModalState({
              isOpen: false,
              requiredPosition: null,
              replacingPlayer: null,
            })
          }
          requiredPosition={activeModalState.requiredPosition}
          currentSquadPlayerIds={players.map((p) => p.playerId)}
          clubCounts={clubCounts}
          remainingBudget={remainingBudgetTenths}
          replacingPlayer={activeModalState.replacingPlayer}
          onSelectPlayer={handleReplacePlayer}
        />
      </div>

      <DragOverlay dropAnimation={null}>
        {activeDragPlayer ? (
          <div className="scale-110 opacity-90 shadow-2xl drop-shadow-[0_0_15px_rgba(52,211,153,0.5)] cursor-grabbing z-50">
            <PlayerCard
              player={activeDragPlayer.player}
              positionSlot={activeDragPlayer.player.position}
              isStarter={activeDragPlayer.isStarter}
              isCaptain={activeDragPlayer.isCaptain}
              isViceCaptain={activeDragPlayer.isViceCaptain}
              isOverlay={true}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
