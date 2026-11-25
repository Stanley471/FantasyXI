/**
 * H2H Squad Comparison Component
 * Displays manager's squad with live projected scores, formation, and bench
 */

'use client';

import React, { useMemo } from 'react';

interface PlayerData {
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
}

interface SquadComparisonProps {
  title: string;
  squad: PlayerData[];
  onPlayerSelect?: (playerId: string) => void;
  selectedPlayerId?: string | null;
}

export const H2HSquadComparison: React.FC<SquadComparisonProps> = ({
  title,
  squad,
  onPlayerSelect,
  selectedPlayerId,
}) => {
  const { activeSquad, benchSquad, stats } = useMemo(() => {
    const active = squad.filter((p) => p.isOnPitch);
    const bench = squad.filter((p) => p.isBenched);
    const totalProjected = squad.reduce((sum, p) => sum + p.projectedFinalScore, 0);

    return {
      activeSquad: active,
      benchSquad: bench,
      stats: { totalProjected },
    };
  }, [squad]);

  const getPositionColor = (position: string): string => {
    const colors: { [key: string]: string } = {
      'Goalkeeper': '#ff9800',
      'Defender': '#4caf50',
      'Midfielder': '#2196f3',
      'Forward': '#f44336',
    };
    return colors[position] || '#9e9e9e';
  };

  return (
    <div style={{ padding: '1.5rem', border: '1px solid #ddd', borderRadius: '8px' }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      
      <div style={{ marginBottom: '1.5rem', display: 'flex', gap: '1rem' }}>
        <div style={{ padding: '0.5rem 1rem', background: '#f5f5f5', borderRadius: '4px' }}>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>Projected</div>
          <div style={{ fontSize: '1.3rem', fontWeight: 'bold' }}>{stats.totalProjected}</div>
        </div>
      </div>

      {/* Active XI */}
      <div style={{ marginBottom: '2rem' }}>
        <h4 style={{ fontSize: '0.95rem', marginBottom: '1rem' }}>Active XI ({activeSquad.length})</h4>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
          gap: '0.75rem',
        }}>
          {activeSquad.map((player) => (
            <div
              key={player.playerId}
              onClick={() => onPlayerSelect?.(player.playerId)}
              style={{
                padding: '0.75rem',
                background: selectedPlayerId === player.playerId ? '#e8f5e9' : '#f9f9f9',
                border: selectedPlayerId === player.playerId ? '2px solid #4caf50' : '1px solid #ddd',
                borderRadius: '6px',
                cursor: 'pointer',
                position: 'relative',
              }}
            >
              {player.multiplier === 2 && (
                <div style={{
                  position: 'absolute',
                  top: '-8px',
                  left: '-8px',
                  width: '24px',
                  height: '24px',
                  background: '#f39c12',
                  color: 'white',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.75rem',
                  fontWeight: 'bold',
                  border: '2px solid white',
                }}>
                  C
                </div>
              )}
              
              <div style={{
                position: 'absolute',
                top: '0.5rem',
                right: '0.5rem',
                width: '20px',
                height: '20px',
                background: getPositionColor(player.playerPosition),
                color: 'white',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '0.7rem',
                fontWeight: 'bold',
              }}>
                {player.playerPosition[0]}
              </div>

              <div style={{ fontSize: '0.8rem', fontWeight: '600', marginBottom: '0.25rem' }}>
                {player.playerName}
              </div>
              <div style={{ fontSize: '0.7rem', color: '#666', marginBottom: '0.5rem' }}>
                {player.playerTeam}
              </div>

              <div style={{
                fontSize: '1.3rem',
                fontWeight: 'bold',
                color: '#2ecc71',
                textAlign: 'center',
                marginBottom: '0.25rem',
              }}>
                {player.projectedFinalScore}
              </div>

              {player.liveBonus > 0 && (
                <div style={{ fontSize: '0.7rem', color: '#f39c12', textAlign: 'center' }}>
                  +{player.liveBonus} bonus
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Bench */}
      {benchSquad.length > 0 && (
        <div>
          <h4 style={{ fontSize: '0.95rem', marginBottom: '1rem' }}>Bench ({benchSquad.length})</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {benchSquad.map((player) => (
              <div
                key={player.playerId}
                onClick={() => onPlayerSelect?.(player.playerId)}
                style={{
                  padding: '0.75rem',
                  background: selectedPlayerId === player.playerId ? '#e3f2fd' : '#f9f9f9',
                  border: selectedPlayerId === player.playerId ? '2px solid #2196f3' : '1px solid #ddd',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: '600' }}>{player.playerName}</div>
                  <div style={{ fontSize: '0.75rem', color: '#666' }}>
                    {player.playerTeam} • {player.playerPosition}
                  </div>
                </div>
                <div style={{ fontSize: '1.2rem', fontWeight: 'bold', color: '#2ecc71' }}>
                  {player.projectedFinalScore}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default H2HSquadComparison;
