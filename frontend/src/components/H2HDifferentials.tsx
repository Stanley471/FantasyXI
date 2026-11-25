/**
 * H2H Player Differentials Component
 * Shows key squad differences with color-coded impact indicators
 */

'use client';

import React, { useMemo } from 'react';

interface PlayerData {
  playerId: string;
  playerName: string;
  playerTeam: string;
  playerPosition: string;
  multiplier: number;
  projectedFinalScore: number;
}

interface H2HDifferentialsProps {
  homeSquad: PlayerData[];
  awaySquad: PlayerData[];
  selectedPlayerId?: string | null;
}

interface Differential {
  playerId: string;
  playerName: string;
  playerTeam: string;
  position: string;
  inHome: boolean;
  inAway: boolean;
  homeCaptain: boolean;
  awayCaptain: boolean;
  homeScore: number;
  awayScore: number;
  difference: number;
  differentialType: 'advantage-home' | 'advantage-away' | 'unique-away' | 'unique-home';
}

export const H2HDifferentials: React.FC<H2HDifferentialsProps> = ({
  homeSquad,
  awaySquad,
  selectedPlayerId,
}) => {
  const differentials = useMemo(() => {
    const homeMap = new Map(homeSquad.map((p) => [p.playerId, p]));
    const awayMap = new Map(awaySquad.map((p) => [p.playerId, p]));
    const allPlayerIds = new Set([...homeMap.keys(), ...awayMap.keys()]);

    const diffs: Differential[] = [];

    for (const playerId of allPlayerIds) {
      const homePlayer = homeMap.get(playerId);
      const awayPlayer = awayMap.get(playerId);

      const inHome = !!homePlayer;
      const inAway = !!awayPlayer;
      const homeScore = homePlayer?.projectedFinalScore || 0;
      const awayScore = awayPlayer?.projectedFinalScore || 0;
      const difference = awayScore - homeScore;

      let differentialType: Differential['differentialType'] = 'unique-home';

      if (inHome && inAway) {
        if (difference > 0) differentialType = 'advantage-away';
        else if (difference < 0) differentialType = 'advantage-home';
      } else if (inAway && !inHome) {
        differentialType = 'unique-away';
      }

      diffs.push({
        playerId,
        playerName: homePlayer?.playerName || awayPlayer?.playerName || '',
        playerTeam: homePlayer?.playerTeam || awayPlayer?.playerTeam || '',
        position: homePlayer?.playerPosition || awayPlayer?.playerPosition || '',
        inHome,
        inAway,
        homeCaptain: homePlayer?.multiplier === 2 || false,
        awayCaptain: awayPlayer?.multiplier === 2 || false,
        homeScore,
        awayScore,
        difference,
        differentialType,
      });
    }

    return diffs.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference));
  }, [homeSquad, awaySquad]);

  const topDifferentials = useMemo(() => {
    return differentials.filter((d) => d.differentialType !== 'unique-home' || d.inHome).slice(0, 8);
  }, [differentials]);

  const getDifferentialColor = (type: string): string => {
    const colors: { [key: string]: string } = {
      'advantage-home': '#2ecc71',
      'advantage-away': '#e74c3c',
      'unique-away': '#f39c12',
      'unique-home': '#3498db',
    };
    return colors[type] || '#95a5a6';
  };

  const getDifferentialLabel = (type: string): string => {
    const labels: { [key: string]: string } = {
      'advantage-home': '✓ Home',
      'advantage-away': '✓ Away',
      'unique-away': 'Away Only',
      'unique-home': 'Home Only',
    };
    return labels[type] || 'Unknown';
  };

  return (
    <div style={{ padding: '1.5rem', border: '1px solid #ddd', borderRadius: '8px' }}>
      <h3 style={{ marginTop: 0 }}>Key Differentials</h3>

      {topDifferentials.length === 0 ? (
        <p style={{ color: '#999' }}>No significant differentials</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {topDifferentials.map((diff, index) => {
            const isAdvantageAway = diff.difference > 0;
            const impactPercentage = Math.abs(diff.difference);

            return (
              <div
                key={diff.playerId}
                style={{
                  padding: '1rem',
                  background: selectedPlayerId === diff.playerId ? '#e8f5e9' : '#f9f9f9',
                  border: selectedPlayerId === diff.playerId ? '2px solid #4caf50' : '1px solid #ddd',
                  borderRadius: '6px',
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                {/* Impact bar */}
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${Math.min(impactPercentage * 5, 100)}%`,
                    background: isAdvantageAway ? 'rgba(231, 76, 60, 0.1)' : 'rgba(46, 204, 113, 0.1)',
                    zIndex: 0,
                  }}
                />

                <div style={{ position: 'relative', zIndex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: '600', marginBottom: '0.25rem' }}>{diff.playerName}</div>
                    <div style={{ fontSize: '0.85rem', color: '#666' }}>
                      {diff.playerTeam} • {diff.position}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    {diff.inHome && (
                      <div style={{
                        padding: '0.4rem 0.6rem',
                        background: '#e3f2fd',
                        border: '1px solid #bbdefb',
                        borderRadius: '3px',
                        textAlign: 'center',
                        minWidth: '45px',
                      }}>
                        <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#2196f3' }}>
                          {diff.homeScore}
                        </div>
                        {diff.homeCaptain && (
                          <div style={{ fontSize: '0.7rem', color: '#f39c12', fontWeight: 'bold' }}>C</div>
                        )}
                      </div>
                    )}

                    {diff.inAway && (
                      <div style={{
                        padding: '0.4rem 0.6rem',
                        background: '#ffebee',
                        border: '1px solid #ffcdd2',
                        borderRadius: '3px',
                        textAlign: 'center',
                        minWidth: '45px',
                      }}>
                        <div style={{ fontSize: '1.1rem', fontWeight: 'bold', color: '#e74c3c' }}>
                          {diff.awayScore}
                        </div>
                        {diff.awayCaptain && (
                          <div style={{ fontSize: '0.7rem', color: '#f39c12', fontWeight: 'bold' }}>C</div>
                        )}
                      </div>
                    )}

                    <div style={{
                      padding: '0.5rem 1rem',
                      background: getDifferentialColor(diff.differentialType),
                      color: 'white',
                      borderRadius: '4px',
                      fontSize: '0.85rem',
                      fontWeight: '600',
                      whiteSpace: 'nowrap',
                    }}>
                      {getDifferentialLabel(diff.differentialType)}
                      {diff.difference !== 0 && ` (${diff.difference > 0 ? '+' : ''}${diff.difference})`}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Summary stats */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '1rem',
        marginTop: '1.5rem',
      }}>
        <div style={{ padding: '0.75rem', background: '#f5f5f5', borderRadius: '4px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>Players Both Have</div>
          <div style={{ fontSize: '1.3rem', fontWeight: 'bold' }}>
            {differentials.filter((d) => d.inHome && d.inAway).length}
          </div>
        </div>
        <div style={{ padding: '0.75rem', background: '#f5f5f5', borderRadius: '4px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>Home Unique</div>
          <div style={{ fontSize: '1.3rem', fontWeight: 'bold' }}>
            {differentials.filter((d) => d.inHome && !d.inAway).length}
          </div>
        </div>
        <div style={{ padding: '0.75rem', background: '#f5f5f5', borderRadius: '4px', textAlign: 'center' }}>
          <div style={{ fontSize: '0.8rem', color: '#666' }}>Away Unique</div>
          <div style={{ fontSize: '1.3rem', fontWeight: 'bold' }}>
            {differentials.filter((d) => !d.inHome && d.inAway).length}
          </div>
        </div>
      </div>
    </div>
  );
};

export default H2HDifferentials;
