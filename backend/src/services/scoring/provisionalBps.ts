export interface BpsCandidate {
  playerId: number;
  fixtureId: number;
  bps: number;
  minutes: number;
}

/**
 * Allocate provisional FPL bonus from the live feed's current BPS totals.
 * Tied BPS ranks receive the same award and consume subsequent rank places.
 */
export function allocateProvisionalBonus(candidates: BpsCandidate[]): Map<string, number> {
  const awards = new Map<string, number>();
  const byFixture = new Map<number, BpsCandidate[]>();
  for (const candidate of candidates) {
    if (!Number.isInteger(candidate.bps) || candidate.bps < 0) continue;
    if (candidate.minutes <= 0 || candidate.bps <= 0) continue;
    const group = byFixture.get(candidate.fixtureId) ?? [];
    group.push(candidate);
    byFixture.set(candidate.fixtureId, group);
  }

  for (const players of byFixture.values()) {
    players.sort((a, b) => b.bps - a.bps || a.playerId - b.playerId);
    let index = 0;
    while (index < players.length && index < 3) {
      let end = index + 1;
      while (end < players.length && players[end].bps === players[index].bps) end++;
      const award = Math.max(0, 3 - index);
      if (award > 0) for (let tied = index; tied < end; tied++) {
        awards.set(`${players[tied].fixtureId}:${players[tied].playerId}`, award);
      }
      index = end;
    }
  }
  return awards;
}
