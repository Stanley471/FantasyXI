"use client";

import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";

export interface BracketTeam {
  id: string;
  name: string;
  seed?: number;
  score?: number;
}

export interface BracketMatch {
  id: string;
  round: number;
  position: number;
  home: BracketTeam | null;
  away: BracketTeam | null;
  winner?: BracketTeam;
  nextMatchId?: string;
  nextSlot?: "home" | "away";
}

interface TournamentBracketProps {
  teams: BracketTeam[];
  onSeedChange?: (teamId: string, newSeed: number) => void;
  readonly?: boolean;
}

export const TournamentBracket: React.FC<TournamentBracketProps> = ({
  teams,
  onSeedChange,
  readonly = false,
}) => {
  const [matches, setMatches] = useState<BracketMatch[]>([]);
  const [draggedTeam, setDraggedTeam] = useState<BracketTeam | null>(null);

  // Build initial bracket from seeded teams
  React.useEffect(() => {
    if (teams.length === 0) return;

    const sorted = [...teams].sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0));
    const totalRounds = Math.ceil(Math.log2(sorted.length));
    const bracketSize = Math.pow(2, totalRounds);
    const byes = bracketSize - sorted.length;

    const initialMatches: BracketMatch[] = [];
    for (let i = 0; i < bracketSize / 2; i++) {
      const homeIdx = i * 2;
      const awayIdx = i * 2 + 1;
      const home = homeIdx < sorted.length ? sorted[homeIdx] : null;
      const away = awayIdx < sorted.length ? sorted[awayIdx] : null;

      initialMatches.push({
        id: `round-0-match-${i}`,
        round: 0,
        position: i,
        home,
        away,
      });
    }

    setMatches(initialMatches);
  }, [teams]);

  const handleDragStart = (team: BracketTeam) => {
    if (readonly) return;
    setDraggedTeam(team);
  };

  const handleDragOver = (e: React.DragEvent, matchId: string, slot: "home" | "away") => {
    if (readonly || !draggedTeam) return;
    e.preventDefault();

    setMatches((prev) =>
      prev.map((m) => {
        if (m.id !== matchId) return m;
        const updated = { ...m };
        if (slot === "home") updated.home = draggedTeam;
        else updated.away = draggedTeam;
        return updated;
      })
    );
  };

  const handleDrop = (matchId: string) => {
    if (readonly || !draggedTeam) return;
    setDraggedTeam(null);
    onSeedChange?.(draggedTeam.id, 0);
  };

  const getRoundLabel = (round: number, totalRounds: number) => {
    if (round === totalRounds - 1) return "Final";
    if (round === totalRounds - 2) return "Semi-Finals";
    if (round === totalRounds - 3) return "Quarter-Finals";
    return `Round ${round + 1}`;
  };

  if (teams.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 border-2 border-dashed border-slate-800 rounded-xl text-slate-500 text-sm">
        No teams registered for this bracket yet.
      </div>
    );
  }

  const totalRounds = Math.ceil(Math.log2(teams.length));

  return (
    <div className="w-full overflow-x-auto">
      <div className="flex gap-8 min-w-[800px]">
        {Array.from({ length: totalRounds }).map((_, roundIndex) => {
          const roundMatches = matches.filter((m) => m.round === roundIndex);
          const roundLabel = getRoundLabel(roundIndex, totalRounds);

          return (
            <div key={roundIndex} className="flex-1 flex flex-col gap-4">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 text-center">
                {roundLabel}
              </div>

              <div className="flex flex-col justify-around flex-1 gap-3">
                <AnimatePresence>
                  {roundMatches.map((match, idx) => (
                    <motion.div
                      key={match.id}
                      layout
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.2 }}
                      className={`flex flex-col gap-2 ${
                        roundIndex < totalRounds - 1 ? "mb-8" : ""
                      }`}
                    >
                      {/* Home slot */}
                      <div
                        draggable={!readonly}
                        onDragStart={() => match.home && handleDragStart(match.home)}
                        onDragOver={(e) => handleDragOver(e, match.id, "home")}
                        onDrop={() => handleDrop(match.id)}
                        className={`px-3 py-2 rounded-lg border text-xs font-mono transition-colors ${
                          match.home
                            ? "bg-slate-900 border-slate-700 text-white cursor-grab"
                            : "bg-slate-950 border-slate-800 text-slate-600 border-dashed"
                        }`}
                      >
                        {match.home ? (
                          <div className="flex items-center justify-between">
                            <span className="truncate">{match.home.name}</span>
                            {match.home.seed !== undefined && (
                              <span className="text-slate-500 ml-2">#{match.home.seed}</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-600">TBD</span>
                        )}
                      </div>

                      {/* VS label */}
                      <div className="text-center text-[10px] font-bold text-slate-600 uppercase tracking-widest">
                        vs
                      </div>

                      {/* Away slot */}
                      <div
                        draggable={!readonly}
                        onDragStart={() => match.away && handleDragStart(match.away)}
                        onDragOver={(e) => handleDragOver(e, match.id, "away")}
                        onDrop={() => handleDrop(match.id)}
                        className={`px-3 py-2 rounded-lg border text-xs font-mono transition-colors ${
                          match.away
                            ? "bg-slate-900 border-slate-700 text-white cursor-grab"
                            : "bg-slate-950 border-slate-800 text-slate-600 border-dashed"
                        }`}
                      >
                        {match.away ? (
                          <div className="flex items-center justify-between">
                            <span className="truncate">{match.away.name}</span>
                            {match.away.seed !== undefined && (
                              <span className="text-slate-500 ml-2">#{match.away.seed}</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-slate-600">TBD</span>
                        )}
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
              </div>
            </div>
          );
        })}
      </div>

      {draggedTeam && (
        <div className="fixed bottom-4 right-4 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-xs text-white shadow-xl z-50">
          Dragging: <span className="font-bold">{draggedTeam.name}</span>
        </div>
      )}
    </div>
  );
};
