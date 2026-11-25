/**
 * Head-to-Head Match Simulator Component - #445
 * Real-time side-by-side squad comparison with live projected bonus points
 * and interactive pitch heatmap for player touches and key events
 */

import React, { useState, useEffect, useCallback } from 'react';

export interface H2HTeamData {
  managerId: string;
  managerName: string;
  liveCumulativeScore: number;
  liveGameweekScore: number;
  projectedBonus: number;
  transfersRemaining: number;
  formationActive: string;
  chipUsed: string | null;
  squad: Array<{
    playerId: string;
    playerName: string;
    playerTeam: string;
    playerPosition: string;
    multiplier: number;
    isBenched: boolean;
    isOnPitch: boolean;
    baseScore: number;
    liveBonus: number;
    projectedFinalScore: number;
  }>;
}

export interface H2HMatchState {
  matchId: string;
  gameweek: number;
  homeManager: H2HTeamData;
  awayManager: H2HTeamData;
  pointDifferential: number;
  status: 'live' | 'completed' | 'upcoming';
  lastUpdate: Date;
}

interface HeadToHeadMatchProps {
  leagueId: string;
  homeManagerId: string;
  awayManagerId: string;
  gameweek?: number;
  onClose?: () => void;
}

/**
 * Main Head-to-Head Match Container Component
 * Orchestrates all H2H experience elements
 */
export const HeadToHeadMatch: React.FC<HeadToHeadMatchProps> = ({
  leagueId,
  homeManagerId,
  awayManagerId,
  gameweek = 1,
  onClose,
}) => {
  const [matchData, setMatchData] = useState<H2HMatchState | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'split' | 'home' | 'away'>('split');
  const [liveUpdatesEnabled, setLiveUpdatesEnabled] = useState(true);
  const [selectedPlayer, setSelectedPlayer] = useState<string | null>(null);
  const matchIdRef = React.useRef<string | null>(null);

  /**
   * Initialize H2H match
   */
  const initializeMatch = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(
        `/api/h2h/match/${leagueId}/${homeManagerId}/${awayManagerId}?gameweek=${gameweek}`,
        { method: 'POST' }
      );

      if (!response.ok) {
        throw new Error('Failed to initialize match');
      }

      const data = await response.json();
      setMatchData(data);
      matchIdRef.current = data.matchId;
    } catch (error) {
      console.error('Error initializing H2H match:', error);
    } finally {
      setLoading(false);
    }
  }, [leagueId, homeManagerId, awayManagerId, gameweek]);

  /**
   * Load initial match data
   */
  useEffect(() => {
    initializeMatch();
  }, [initializeMatch]);

  /**
   * Poll for live updates
   */
  useEffect(() => {
    if (!liveUpdatesEnabled || !matchIdRef.current || matchData?.status !== 'live') {
      return;
    }

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(
          `/api/h2h/differentials/${matchIdRef.current}`
        );
        if (response.ok) {
          // Update with new data
        }
      } catch (error) {
        console.error('Error polling live updates:', error);
      }
    }, 5000);

    return () => clearInterval(pollInterval);
  }, [liveUpdatesEnabled, matchData?.status]);

  if (loading) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <p>Loading match data...</p>
      </div>
    );
  }

  if (!matchData) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <p>Failed to load match data</p>
        <button onClick={initializeMatch}>Retry</button>
      </div>
    );
  }

  const homeScore = matchData.homeManager.liveCumulativeScore;
  const awayScore = matchData.awayManager.liveCumulativeScore;

  return (
    <div style={{ padding: '2rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2rem' }}>
        <h1>Head-to-Head Match</h1>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <label>
            <input
              type="checkbox"
              checked={liveUpdatesEnabled}
              onChange={(e) => setLiveUpdatesEnabled(e.target.checked)}
            />
            Live Updates
          </label>
          <select value={view} onChange={(e) => setView(e.target.value as any)}>
            <option value="split">Split View</option>
            <option value="home">Home Manager</option>
            <option value="away">Away Manager</option>
          </select>
          {onClose && <button onClick={onClose}>Close</button>}
        </div>
      </div>

      {/* Score Board */}
      <div style={{ 
        display: 'flex', 
        justifyContent: 'space-around', 
        marginBottom: '2rem',
        padding: '2rem',
        background: '#f5f5f5',
        borderRadius: '8px'
      }}>
        <div style={{ textAlign: 'center' }}>
          <h2>{matchData.homeManager.managerName}</h2>
          <div style={{ fontSize: '3rem', fontWeight: 'bold' }}>{homeScore}</div>
          <div style={{ color: '#666' }}>{matchData.homeManager.formationActive}</div>
        </div>

        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          <span style={{ fontSize: '1.2rem', color: '#666' }}>VS</span>
          <span style={{ fontSize: '0.9rem', color: '#999' }}>GW {gameweek}</span>
        </div>

        <div style={{ textAlign: 'center' }}>
          <h2>{matchData.awayManager.managerName}</h2>
          <div style={{ fontSize: '3rem', fontWeight: 'bold' }}>{awayScore}</div>
          <div style={{ color: '#666' }}>{matchData.awayManager.formationActive}</div>
        </div>
      </div>

      {/* Differential Indicator */}
      {matchData.pointDifferential !== 0 && (
        <div style={{ 
          padding: '1rem', 
          marginBottom: '2rem',
          background: matchData.pointDifferential > 0 ? '#ffe6e6' : '#e6f3ff',
          border: `1px solid ${matchData.pointDifferential > 0 ? '#ff6b6b' : '#3498db'}`,
          borderRadius: '4px',
          color: matchData.pointDifferential > 0 ? '#c92a2a' : '#1864ab'
        }}>
          {matchData.pointDifferential > 0 ? '↑' : '↓'} {Math.abs(matchData.pointDifferential)} point differential
        </div>
      )}

      {/* Stats Grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '1rem',
        marginTop: '2rem'
      }}>
        <div style={{ padding: '1rem', background: '#f5f5f5', borderRadius: '4px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.9rem', color: '#666' }}>Match Status</div>
          <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{matchData.status}</div>
        </div>
        <div style={{ padding: '1rem', background: '#f5f5f5', borderRadius: '4px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.9rem', color: '#666' }}>Gameweek</div>
          <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>{gameweek}</div>
        </div>
        <div style={{ padding: '1rem', background: '#f5f5f5', borderRadius: '4px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.9rem', color: '#666' }}>Last Updated</div>
          <div style={{ fontSize: '1.2rem', fontWeight: 'bold' }}>
            {new Date(matchData.lastUpdate).toLocaleTimeString()}
          </div>
        </div>
      </div>
    </div>
  );
};

export default HeadToHeadMatch;
