/**
 * H2H Interactive Pitch Visualization
 * SVG-based football pitch with player touch heatmap and event indicators
 */

'use client';

import React, { useState, useEffect } from 'react';

interface PlayerTouch {
  playerId: string;
  playerName: string;
  teamCode: string;
  position: { x: number; y: number };
  touchCount: number;
  eventTypes: Array<{
    type: 'touch' | 'shot' | 'pass' | 'tackle' | 'clearance' | 'interception';
    count: number;
  }>;
}

interface H2HPitchProps {
  matchId: string;
  onPlayerSelect?: (playerId: string) => void;
}

export const H2HPitch: React.FC<H2HPitchProps> = ({ matchId, onPlayerSelect }) => {
  const [pitchData, setPitchData] = useState<PlayerTouch[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoveredPlayer, setHoveredPlayer] = useState<string | null>(null);

  useEffect(() => {
    const fetchPitchData = async () => {
      try {
        setLoading(true);
        const response = await fetch(`/api/h2h/pitch/${matchId}`);
        if (response.ok) {
          const data = await response.json();
          setPitchData(data.playerTouches || []);
        }
      } catch (error) {
        console.error('Error fetching pitch data:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchPitchData();
    const interval = setInterval(fetchPitchData, 10000);
    return () => clearInterval(interval);
  }, [matchId]);

  const getEventColor = (eventType: string): string => {
    const colors: { [key: string]: string } = {
      touch: '#3498db',
      shot: '#e74c3c',
      pass: '#2ecc71',
      tackle: '#f39c12',
      clearance: '#9b59b6',
      interception: '#1abc9c',
    };
    return colors[eventType] || '#95a5a6';
  };

  const getHeatmapIntensity = (touchCount: number, maxTouches: number): number => {
    return Math.min(1, touchCount / Math.max(1, maxTouches));
  };

  if (loading) {
    return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading pitch data...</div>;
  }

  if (!pitchData.length) {
    return <div style={{ padding: '2rem', textAlign: 'center', color: '#999' }}>No match events yet</div>;
  }

  const maxTouches = Math.max(...pitchData.map((p) => p.touchCount), 1);

  return (
    <div style={{ padding: '1.5rem', border: '1px solid #ddd', borderRadius: '8px' }}>
      <h3 style={{ marginTop: 0 }}>Live Pitch Heatmap</h3>

      <div style={{
        background: '#2d5016',
        border: '2px solid #1a3a0a',
        borderRadius: '6px',
        aspectRatio: '1',
        maxWidth: '100%',
        position: 'relative',
      }}>
        <svg
          viewBox="0 0 100 100"
          style={{ width: '100%', height: '100%' }}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Pitch background */}
          <rect width="100" height="100" fill="#2d5016" />

          {/* Field lines */}
          <line x1="50" y1="0" x2="50" y2="100" stroke="white" strokeWidth="0.5" />
          <rect x="0" y="0" width="100" height="100" fill="none" stroke="white" strokeWidth="0.5" />

          {/* Center circle */}
          <circle cx="50" cy="50" r="8" fill="none" stroke="white" strokeWidth="0.5" />

          {/* Penalty areas */}
          <rect x="0" y="17" width="20" height="66" fill="none" stroke="white" strokeWidth="0.5" />
          <rect x="80" y="17" width="20" height="66" fill="none" stroke="white" strokeWidth="0.5" />

          {/* Player touch heatmap */}
          {pitchData.map((player) => {
            const intensity = getHeatmapIntensity(player.touchCount, maxTouches);
            const heatmapOpacity = 0.2 + intensity * 0.5;

            return (
              <g key={player.playerId}>
                {/* Heatmap circle */}
                <circle
                  cx={player.position.x}
                  cy={player.position.y}
                  r={3 + intensity * 4}
                  fill="rgba(255, 107, 107, 0.4)"
                  opacity={heatmapOpacity}
                />

                {/* Player touch point */}
                <circle
                  cx={player.position.x}
                  cy={player.position.y}
                  r={1.2 + intensity * 1.8}
                  fill={player.teamCode === 'HOME' ? '#3498db' : '#e74c3c'}
                  style={{ cursor: 'pointer' }}
                  opacity={hoveredPlayer === player.playerId ? 1 : 0.8}
                  onMouseEnter={() => setHoveredPlayer(player.playerId)}
                  onMouseLeave={() => setHoveredPlayer(null)}
                  onClick={() => onPlayerSelect?.(player.playerId)}
                />
              </g>
            );
          })}
        </svg>

        {/* Tooltip */}
        {hoveredPlayer && (
          <div style={{
            position: 'absolute',
            bottom: '1rem',
            left: '1rem',
            background: 'rgba(0, 0, 0, 0.9)',
            color: 'white',
            padding: '0.75rem',
            borderRadius: '4px',
            fontSize: '0.85rem',
            maxWidth: '200px',
            zIndex: 10,
          }}>
            {(() => {
              const player = pitchData.find((p) => p.playerId === hoveredPlayer);
              return player ? (
                <>
                  <div style={{ fontWeight: '600', marginBottom: '0.25rem' }}>{player.playerName}</div>
                  <div style={{ color: '#aaa', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                    {player.teamCode}
                  </div>
                  <div>Touches: {player.touchCount}</div>
                  {player.eventTypes.map((event) => (
                    <div key={event.type} style={{ fontSize: '0.8rem' }}>
                      {event.type}: {event.count}
                    </div>
                  ))}
                </>
              ) : null;
            })()}
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))',
        gap: '0.75rem',
        marginTop: '1rem',
        fontSize: '0.85rem',
      }}>
        {['touch', 'shot', 'pass', 'tackle', 'clearance', 'interception'].map((type) => (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div
              style={{
                width: '12px',
                height: '12px',
                background: getEventColor(type),
                borderRadius: '50%',
              }}
            />
            <span style={{ textTransform: 'capitalize' }}>{type}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default H2HPitch;
