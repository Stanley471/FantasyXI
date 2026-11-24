"use client";

/**
 * Historical Standings Scrubber Component
 * Interactive slider for gameweek navigation with smooth table transitions
 * Supports keyboard navigation and animated rank changes
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import styles from "./StandingsScrubber.module.css";

export interface StandingsData {
  gameweekId: number;
  standings: Array<{
    rank: number;
    membershipId: string;
    username: string;
    totalPoints: number;
    gameweekPoints: number;
    transfersUsed: number;
    transferCost: number;
    benchedPoints: number;
    chipUsed: string | null;
  }>;
  totalGameweeks: number;
  meta?: {
    queryTimeMs: number;
    cached?: boolean;
  };
}

interface StandingsScrubberProps {
  leagueId: string;
  onGameweekChange?: (gameweekId: number) => void;
  autoPlay?: boolean;
  autoPlaySpeed?: number; // ms between gameweeks
}

export const StandingsScrubber: React.FC<StandingsScrubberProps> = ({
  leagueId,
  onGameweekChange,
  autoPlay = false,
  autoPlaySpeed = 1000,
}) => {
  const [currentGameweek, setCurrentGameweek] = useState<number>(1);
  const [standingsData, setStandingsData] = useState<StandingsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const [totalGameweeks, setTotalGameweeks] = useState<number>(38);
  const playbackRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Fetch standings for current gameweek
   */
  const fetchStandings = useCallback(async (gameweekId: number) => {
    try {
      setLoading(true);
      const response = await fetch(
        `/api/standings/historical/${leagueId}/${gameweekId}`
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch standings: ${response.statusText}`);
      }

      const data: StandingsData = await response.json();
      setStandingsData(data);
      setTotalGameweeks(data.totalGameweeks);
      onGameweekChange?.(gameweekId);
    } catch (error) {
      console.error("Error fetching standings:", error);
    } finally {
      setLoading(false);
    }
  }, [leagueId, onGameweekChange]);

  /**
   * Load initial standings
   */
  useEffect(() => {
    fetchStandings(currentGameweek);
  }, []);

  /**
   * Handle slider change
   */
  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const gameweekId = parseInt(e.target.value, 10);
    setCurrentGameweek(gameweekId);
    setIsPlaying(false);
    fetchStandings(gameweekId);
  };

  /**
   * Handle keyboard navigation
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && currentGameweek > 1) {
        const nextGw = currentGameweek - 1;
        setCurrentGameweek(nextGw);
        fetchStandings(nextGw);
        e.preventDefault();
      } else if (e.key === "ArrowRight" && currentGameweek < totalGameweeks) {
        const nextGw = currentGameweek + 1;
        setCurrentGameweek(nextGw);
        fetchStandings(nextGw);
        e.preventDefault();
      } else if (e.key === " ") {
        setIsPlaying(!isPlaying);
        e.preventDefault();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentGameweek, totalGameweeks, isPlaying, fetchStandings]);

  /**
   * Handle autoplay
   */
  useEffect(() => {
    if (isPlaying && currentGameweek < totalGameweeks) {
      playbackRef.current = setTimeout(() => {
        const nextGw = currentGameweek + 1;
        setCurrentGameweek(nextGw);
        fetchStandings(nextGw);
      }, autoPlaySpeed);
    } else if (isPlaying && currentGameweek === totalGameweeks) {
      setIsPlaying(false);
    }

    return () => {
      if (playbackRef.current) {
        clearTimeout(playbackRef.current);
      }
    };
  }, [isPlaying, currentGameweek, totalGameweeks, fetchStandings, autoPlaySpeed]);

  const handlePlayPause = () => {
    if (currentGameweek === totalGameweeks && !isPlaying) {
      setCurrentGameweek(1);
      fetchStandings(1);
    }
    setIsPlaying(!isPlaying);
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>Historical Standings</h2>
        <div className={styles.gameweekInfo}>
          <span className={styles.currentGw}>Gameweek {currentGameweek}</span>
          <span className={styles.totalGw}>/ {totalGameweeks}</span>
        </div>
      </div>

      <div className={styles.controls}>
        <button
          className={styles.playButton}
          onClick={handlePlayPause}
          aria-label={isPlaying ? "Pause" : "Play"}
          title="Space to toggle"
        >
          {isPlaying ? "⏸" : "▶"}
        </button>

        <input
          type="range"
          min="1"
          max={totalGameweeks}
          value={currentGameweek}
          onChange={handleSliderChange}
          className={styles.slider}
          aria-label="Gameweek scrubber"
        />

        <div className={styles.speedControl}>
          <label htmlFor="speed">Speed:</label>
          <select
            id="speed"
            defaultValue="1000"
            onChange={(e) => {
              // Speed adjustment would require state management
            }}
            className={styles.speedSelect}
          >
            <option value="500">2x</option>
            <option value="1000">1x</option>
            <option value="2000">0.5x</option>
          </select>
        </div>
      </div>

      <div className={styles.tableContainer}>
        <AnimatePresence mode="wait">
          {loading && (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className={styles.loading}
            >
              Loading standings...
            </motion.div>
          )}

          {standingsData && !loading && (
            <motion.div
              key={`standings-${currentGameweek}`}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ duration: 0.2 }}
              className={styles.tableWrapper}
            >
              <StandingsTable data={standingsData} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {standingsData?.meta && (
        <div className={styles.meta}>
          <span className={styles.queryTime}>
            Query: {standingsData.meta.queryTimeMs}ms
            {standingsData.meta.cached && " (cached)"}
          </span>
        </div>
      )}

      <div className={styles.shortcuts}>
        <small>
          ← → to navigate • Space to play/pause • Click slider to jump
        </small>
      </div>
    </div>
  );
};

/**
 * Standings Table with animated rank transitions
 */
interface StandingsTableProps {
  data: StandingsData;
}

const StandingsTable: React.FC<StandingsTableProps> = ({ data }) => {
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th className={styles.rankCol}>Rank</th>
          <th className={styles.managerCol}>Manager</th>
          <th className={styles.pointsCol}>Points</th>
          <th className={styles.gwPointsCol}>GW Pts</th>
          <th className={styles.transfersCol}>Transfers</th>
          <th className={styles.costCol}>Cost</th>
          <th className={styles.chipCol}>Chip</th>
        </tr>
      </thead>
      <tbody>
        <AnimatePresence>
          {data.standings.map((standing) => (
            <ManagerRow key={standing.membershipId} standing={standing} />
          ))}
        </AnimatePresence>
      </tbody>
    </table>
  );
};

/**
 * Individual manager row with animated rank changes
 */
interface ManagerRowProps {
  standing: StandingsData["standings"][0];
}

const ManagerRow: React.FC<ManagerRowProps> = ({ standing }) => {
  const isHighRank = standing.rank <= 3;
  const isLowRank = standing.rank > 50;

  return (
    <motion.tr
      initial={{ opacity: 0, x: -20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 20 }}
      transition={{ duration: 0.15 }}
      className={`${styles.row} ${isHighRank ? styles.highRank : ""} ${
        isLowRank ? styles.lowRank : ""
      }`}
    >
      <td className={`${styles.rankCol} ${styles.rankCell}`}>
        <motion.span
          key={`rank-${standing.rank}`}
          initial={{ scale: 1.2, y: -10 }}
          animate={{ scale: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 10 }}
        >
          {standing.rank}
        </motion.span>
      </td>
      <td className={styles.managerCol}>
        <span className={styles.managerName}>{standing.username}</span>
      </td>
      <td className={styles.pointsCol}>
        <span className={styles.points}>{standing.totalPoints}</span>
      </td>
      <td className={styles.gwPointsCol}>
        <span className={styles.gwPoints}>
          {standing.gameweekPoints >= 0 ? "+" : ""}
          {standing.gameweekPoints}
        </span>
      </td>
      <td className={styles.transfersCol}>
        <span
          className={`${styles.transfers} ${
            standing.transfersUsed > 0 ? styles.hasTransfers : ""
          }`}
        >
          {standing.transfersUsed}
        </span>
      </td>
      <td className={styles.costCol}>
        <span
          className={`${styles.cost} ${
            standing.transferCost > 0 ? styles.costPenalty : ""
          }`}
        >
          -{standing.transferCost}
        </span>
      </td>
      <td className={styles.chipCol}>
        {standing.chipUsed ? (
          <span className={styles.chip}>{standing.chipUsed}</span>
        ) : (
          <span className={styles.noChip}>—</span>
        )}
      </td>
    </motion.tr>
  );
};

export default StandingsScrubber;
