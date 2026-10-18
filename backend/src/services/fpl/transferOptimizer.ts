import { Position, SQUAD_RULES, type SquadPlayerSelection } from "../../types/index.js";
import { SquadValidator } from "../squad/squadValidator.js";
import { SquadService } from "../squad/squadService.js";

/**
 * Multi-Gameweek Transfer Planning Solver (issue #267).
 *
 * Projects each player's expected points per gameweek from a per-match
 * baseline scaled by fixture difficulty (FDR), availability and the number of
 * fixtures (0 in a blank gameweek, 2 in a double), then searches transfer paths
 * across a 1-5 gameweek horizon.
 *
 * Search: a heuristic branch-and-bound beam search. Each gameweek branches
 * every surviving squad state into "no transfer" plus the best 1..N transfer
 * combinations (same-position swaps that respect budget and the 3-per-club
 * cap). Branches are bounded by keeping only the `beamWidth` states with the
 * best points-so-far plus the guaranteed points of holding the squad for the
 * rest of the horizon. Free transfers roll over (+1 per gameweek, capped at
 * SQUAD_RULES.MAX_FREE_TRANSFERS) and each extra transfer costs
 * SQUAD_RULES.TRANSFER_POINTS_COST points. Gameweek points use the best valid
 * starting XI with the top projected starter captained.
 *
 * The engine is pure and synchronous; plans are only recommendations and are
 * never executed.
 */

export const MIN_HORIZON = 1;
export const MAX_HORIZON = 5;

/** Expected-points multiplier per fixture difficulty rating (1 = easiest). */
export const FDR_MULTIPLIERS: Readonly<Record<number, number>> = {
  1: 1.25,
  2: 1.1,
  3: 1.0,
  4: 0.85,
  5: 0.7,
};

export interface OptimizerPlayer {
  id: number;
  teamId: number;
  position: Position;
  /** Current market price in £m */
  price: number;
  /** Baseline expected points for one match against an average (FDR 3) opponent */
  expectedPointsPerMatch: number;
  /** 0-100; null/undefined means fully available */
  chanceOfPlaying?: number | null;
  /** Predicted price change per gameweek in £m (e.g. 0.1), used for team value */
  predictedPriceChangePerGameweek?: number;
  /** Explicit projection by gameweek id; overrides the fixture model for that gameweek */
  projectedPoints?: Record<number, number>;
}

/** One club's appearance in one match. */
export interface OptimizerFixture {
  gameweekId: number;
  teamId: number;
  /** FDR from the club's perspective, 1-5 */
  difficulty: number;
}

export interface OwnedPlayer {
  playerId: number;
  /** What the club pays out when this player is sold; defaults to the current price */
  sellingPrice?: number;
}

export interface TransferPlanInput {
  squad: OwnedPlayer[];
  /** Money in the bank, £m */
  bank: number;
  /** Free transfers available for the first planned gameweek */
  freeTransfers: number;
  /** Gameweek ids to plan, in order (length 1-5) */
  gameweekIds: number[];
  players: OptimizerPlayer[];
  fixtures: OptimizerFixture[];
  options?: TransferPlanOptions;
}

export interface TransferPlanOptions {
  /** Max transfers considered in a single gameweek (default 2, max 3) */
  maxTransfersPerGameweek?: number;
  /** Squad states kept per gameweek (default 12) */
  beamWidth?: number;
  /** Replacement candidates considered per position (default 15) */
  candidatesPerPosition?: number;
  /** Number of alternative plans returned (default 3) */
  maxPlans?: number;
  /** Points credited per £1.0m of projected team value gained (default 0) */
  teamValueWeight?: number;
  /** Players that must not be sold */
  lockedPlayerIds?: number[];
  /** Players that must not be bought */
  excludedPlayerIds?: number[];
}

export interface PlannedTransfer {
  playerOutId: number;
  playerInId: number;
  position: Position;
  sellPrice: number;
  buyPrice: number;
}

export interface GameweekPlan {
  gameweekId: number;
  transfers: PlannedTransfer[];
  freeTransfersAvailable: number;
  hitCost: number;
  bankAfterTransfers: number;
  projectedPoints: number;
  /** Projected points minus hit cost */
  netPoints: number;
  startingXI: number[];
  bench: number[];
  captainId: number;
  viceCaptainId: number;
  formation: string;
}

export interface TransferPlan {
  gameweeks: GameweekPlan[];
  totalTransfers: number;
  totalHitCost: number;
  projectedPoints: number;
  /** Plan points minus the points of rolling transfers and keeping the squad */
  projectedScoreDelta: number;
  projectedTeamValue: number;
  teamValueDelta: number;
  freeTransfersAfterHorizon: number;
}

export interface TransferPlanResult {
  horizon: number;
  gameweekIds: number[];
  baseline: { projectedPoints: number; projectedTeamValue: number };
  plans: TransferPlan[];
  computeMs: number;
}

export class TransferOptimizerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferOptimizerError";
  }
}

interface SquadState {
  ids: number[];
  sellPrices: Map<number, number>;
  bank: number;
  freeTransfers: number;
  accumulated: number;
  /** accumulated + points of holding the squad for the rest of the horizon */
  bound: number;
  steps: GameweekPlan[];
}

interface Lineup {
  points: number;
  startingXI: number[];
  bench: number[];
  captainId: number;
  viceCaptainId: number;
  formation: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function fdrMultiplier(difficulty: number): number {
  const d = Math.min(5, Math.max(1, difficulty));
  const lo = Math.floor(d);
  const hi = Math.ceil(d);
  return FDR_MULTIPLIERS[lo] + (FDR_MULTIPLIERS[hi] - FDR_MULTIPLIERS[lo]) * (d - lo);
}

export class TransferOptimizerEngine {
  private readonly players = new Map<number, OptimizerPlayer>();
  /** projections[gwIndex].get(playerId) */
  private readonly projections: Array<Map<number, number>> = [];
  /** remaining[gwIndex].get(playerId): projected points from gwIndex to the end */
  private readonly remaining: Array<Map<number, number>> = [];
  private readonly gameweekIds: number[];
  private readonly maxTransfers: number;
  private readonly beamWidth: number;
  private readonly candidatesPerPosition: number;
  private readonly maxPlans: number;
  private readonly teamValueWeight: number;
  private readonly locked: Set<number>;
  private readonly excluded: Set<number>;

  constructor(private readonly input: TransferPlanInput) {
    const opts = input.options ?? {};
    this.gameweekIds = input.gameweekIds;
    this.maxTransfers = opts.maxTransfersPerGameweek ?? 2;
    this.beamWidth = opts.beamWidth ?? 12;
    this.candidatesPerPosition = opts.candidatesPerPosition ?? 15;
    this.maxPlans = opts.maxPlans ?? 3;
    this.teamValueWeight = opts.teamValueWeight ?? 0;
    this.locked = new Set(opts.lockedPlayerIds ?? []);
    this.excluded = new Set(opts.excludedPlayerIds ?? []);

    for (const p of input.players) this.players.set(p.id, p);
    this.validateInput();
    this.buildProjections();
  }

  /** Projected points for one player in one planned gameweek. */
  public projectedPoints(playerId: number, gameweekId: number): number {
    const idx = this.gameweekIds.indexOf(gameweekId);
    return idx === -1 ? 0 : this.projections[idx].get(playerId) ?? 0;
  }

  public solve(): TransferPlanResult {
    const started = performance.now();
    const initialSell = new Map<number, number>();
    for (const owned of this.input.squad) {
      initialSell.set(owned.playerId, owned.sellingPrice ?? this.players.get(owned.playerId)!.price);
    }

    const initial: SquadState = {
      ids: this.input.squad.map((s) => s.playerId),
      sellPrices: initialSell,
      bank: round1(this.input.bank),
      freeTransfers: this.input.freeTransfers,
      accumulated: 0,
      bound: 0,
      steps: [],
    };
    const baseline = this.holdSquad(initial);

    let beam: SquadState[] = [initial];
    for (let gw = 0; gw < this.gameweekIds.length; gw++) {
      const next = new Map<string, SquadState>();
      for (const state of beam) {
        for (const child of this.expand(state, gw)) {
          const key = `${[...child.ids].sort((a, b) => a - b).join(",")}|${child.freeTransfers}|${child.bank}`;
          const existing = next.get(key);
          if (!existing || child.accumulated > existing.accumulated) next.set(key, child);
        }
      }
      beam = [...next.values()].sort((a, b) => b.bound - a.bound).slice(0, this.beamWidth);
    }

    const baselineValue = this.teamValue(initial.ids, initial.bank);
    const plans = beam
      .map((state) => this.toPlan(state, baseline.accumulated, baselineValue))
      .sort(
        (a, b) =>
          b.projectedPoints + this.teamValueWeight * b.teamValueDelta -
            (a.projectedPoints + this.teamValueWeight * a.teamValueDelta) ||
          a.totalTransfers - b.totalTransfers
      )
      .slice(0, this.maxPlans);

    for (const plan of plans) this.assertPlanValid(plan);

    return {
      horizon: this.gameweekIds.length,
      gameweekIds: [...this.gameweekIds],
      baseline: { projectedPoints: round2(baseline.accumulated), projectedTeamValue: baselineValue },
      plans,
      computeMs: round2(performance.now() - started),
    };
  }

  private validateInput(): void {
    const { squad, bank, freeTransfers, gameweekIds } = this.input;
    if (!Array.isArray(gameweekIds) || gameweekIds.length < MIN_HORIZON || gameweekIds.length > MAX_HORIZON) {
      throw new TransferOptimizerError(`Horizon must cover ${MIN_HORIZON}-${MAX_HORIZON} gameweeks`);
    }
    if (new Set(gameweekIds).size !== gameweekIds.length) {
      throw new TransferOptimizerError("gameweekIds must be unique");
    }
    if (!Array.isArray(squad) || squad.length !== SQUAD_RULES.TOTAL_PLAYERS) {
      throw new TransferOptimizerError(`Squad must contain exactly ${SQUAD_RULES.TOTAL_PLAYERS} players`);
    }
    if (new Set(squad.map((s) => s.playerId)).size !== squad.length) {
      throw new TransferOptimizerError("Squad contains duplicate players");
    }
    for (const s of squad) {
      if (!this.players.has(s.playerId)) {
        throw new TransferOptimizerError(`Squad player ${s.playerId} is missing from the player pool`);
      }
    }
    const positions = new Map<Position, number>();
    for (const s of squad) {
      const position = this.players.get(s.playerId)!.position;
      positions.set(position, (positions.get(position) ?? 0) + 1);
    }
    for (const [position, required] of Object.entries(SQUAD_RULES.POSITION_COUNTS)) {
      if ((positions.get(position as Position) ?? 0) !== required) {
        throw new TransferOptimizerError(`Squad must contain exactly ${required} ${position} players`);
      }
    }
    for (const [teamId, count] of this.clubCounts(squad.map((s) => s.playerId))) {
      if (count > SQUAD_RULES.MAX_PER_TEAM) {
        throw new TransferOptimizerError(
          `Squad has ${count} players from team ${teamId}; at most ${SQUAD_RULES.MAX_PER_TEAM} are allowed`
        );
      }
    }
    if (!Number.isFinite(bank) || bank < 0) {
      throw new TransferOptimizerError("bank must be a non-negative number");
    }
    if (!Number.isInteger(freeTransfers) || freeTransfers < 0 || freeTransfers > SQUAD_RULES.MAX_FREE_TRANSFERS) {
      throw new TransferOptimizerError(`freeTransfers must be an integer between 0 and ${SQUAD_RULES.MAX_FREE_TRANSFERS}`);
    }
    if (!Number.isInteger(this.maxTransfers) || this.maxTransfers < 0 || this.maxTransfers > 3) {
      throw new TransferOptimizerError("maxTransfersPerGameweek must be an integer between 0 and 3");
    }
    if (!Number.isInteger(this.beamWidth) || this.beamWidth < 1 || this.beamWidth > 100) {
      throw new TransferOptimizerError("beamWidth must be an integer between 1 and 100");
    }
  }

  private buildProjections(): void {
    const fixturesByTeamGw = new Map<string, number[]>();
    for (const f of this.input.fixtures) {
      const key = `${f.teamId}:${f.gameweekId}`;
      const list = fixturesByTeamGw.get(key) ?? [];
      list.push(f.difficulty);
      fixturesByTeamGw.set(key, list);
    }

    for (const gwId of this.gameweekIds) {
      const proj = new Map<number, number>();
      for (const p of this.players.values()) {
        const explicit = p.projectedPoints?.[gwId];
        let points: number;
        if (explicit !== undefined) {
          points = explicit;
        } else {
          const difficulties = fixturesByTeamGw.get(`${p.teamId}:${gwId}`) ?? [];
          const availability = Math.min(100, Math.max(0, p.chanceOfPlaying ?? 100)) / 100;
          points = difficulties.reduce(
            (sum, d) => sum + Math.max(0, p.expectedPointsPerMatch) * fdrMultiplier(d) * availability,
            0
          );
        }
        proj.set(p.id, points);
      }
      this.projections.push(proj);
    }

    for (let i = this.gameweekIds.length - 1; i >= 0; i--) {
      const rem = new Map<number, number>();
      for (const p of this.players.values()) {
        rem.set(p.id, this.projections[i].get(p.id)! + (this.remaining[0]?.get(p.id) ?? 0));
      }
      this.remaining.unshift(rem);
    }
  }

  /** Best valid starting XI for a squad in one gameweek, top starter captained. */
  private bestLineup(ids: number[], gw: number): Lineup {
    const proj = this.projections[gw];
    const byPos: Record<Position, number[]> = {
      [Position.GKP]: [],
      [Position.DEF]: [],
      [Position.MID]: [],
      [Position.FWD]: [],
    };
    for (const id of ids) byPos[this.players.get(id)!.position].push(id);
    const desc = (a: number, b: number) => proj.get(b)! - proj.get(a)! || a - b;
    for (const list of Object.values(byPos)) list.sort(desc);

    const xi: number[] = [byPos[Position.GKP][0]];
    const rest: number[] = [];
    const take = (pos: Position, n: number) => {
      xi.push(...byPos[pos].slice(0, n));
      rest.push(...byPos[pos].slice(n));
    };
    take(Position.DEF, SQUAD_RULES.MIN_STARTERS.DEF);
    take(Position.MID, SQUAD_RULES.MIN_STARTERS.MID);
    take(Position.FWD, SQUAD_RULES.MIN_STARTERS.FWD);
    rest.sort(desc);
    xi.push(...rest.slice(0, SQUAD_RULES.STARTERS - xi.length));

    const xiSet = new Set(xi);
    const bench = [byPos[Position.GKP][1], ...rest.filter((id) => !xiSet.has(id))];
    const ranked = [...xi].sort(desc);
    const count = (pos: Position) => xi.filter((id) => this.players.get(id)!.position === pos).length;

    return {
      points: xi.reduce((sum, id) => sum + proj.get(id)!, 0) + proj.get(ranked[0])!,
      startingXI: xi,
      bench,
      captainId: ranked[0],
      viceCaptainId: ranked[1],
      formation: `${count(Position.DEF)}-${count(Position.MID)}-${count(Position.FWD)}`,
    };
  }

  /** Points of keeping a squad unchanged from gameweek `from` to the end. */
  private holdPoints(ids: number[], from: number): number {
    let total = 0;
    for (let gw = from; gw < this.gameweekIds.length; gw++) total += this.bestLineup(ids, gw).points;
    return total;
  }

  private holdSquad(initial: SquadState): SquadState {
    let state = initial;
    for (let gw = 0; gw < this.gameweekIds.length; gw++) state = this.applyTransfers(state, gw, []);
    return state;
  }

  /**
   * Branches a state into "hold" plus every feasible 1..N transfer combination
   * built from the candidate moves. Moves are combined before the budget and
   * club checks so a downgrade can fund an upgrade in the same gameweek.
   */
  private expand(state: SquadState, gw: number): SquadState[] {
    const children = [this.applyTransfers(state, gw, [])];
    if (this.maxTransfers === 0) return children;

    const moves = this.candidateMoves(state, gw);
    const gains = moves.map((m) => this.comboGain([m], gw));
    const comboLimit = this.candidatesPerPosition * 4;
    const feasible: PlannedTransfer[][] = [];
    moves.forEach((m, i) => {
      if (gains[i] > 0 && this.comboFeasible(state, [m])) feasible.push([m]);
    });

    // Combinations are built in ascending move order, so each set appears once
    let level = moves.map((_, i) => ({ idx: [i], gain: gains[i] }));
    for (let size = 2; size <= this.maxTransfers; size++) {
      const nextLevel: Array<{ idx: number[]; gain: number }> = [];
      for (const combo of level) {
        for (let j = combo.idx[combo.idx.length - 1] + 1; j < moves.length; j++) {
          const move = moves[j];
          if (combo.idx.some((i) => moves[i].playerOutId === move.playerOutId || moves[i].playerInId === move.playerInId)) {
            continue;
          }
          nextLevel.push({ idx: [...combo.idx, j], gain: combo.gain + gains[j] });
        }
      }
      nextLevel.sort((a, b) => b.gain - a.gain);

      let added = 0;
      for (const candidate of nextLevel) {
        if (added >= comboLimit || candidate.gain <= 0) break;
        const combo = candidate.idx.map((i) => moves[i]);
        if (this.comboFeasible(state, combo)) {
          feasible.push(combo);
          added++;
        }
      }
      level = nextLevel.slice(0, comboLimit);
    }

    for (const combo of feasible) children.push(this.applyTransfers(state, gw, combo));
    return children;
  }

  /** Projected gain of a set of swaps over the rest of the horizon (heuristic ordering only). */
  private comboGain(combo: PlannedTransfer[], gw: number): number {
    const rem = this.remaining[gw];
    return combo.reduce((sum, t) => sum + rem.get(t.playerInId)! - rem.get(t.playerOutId)!, 0);
  }

  /**
   * Candidate swaps for a state: the best upgrades (affordable on their own or
   * not) plus "funding" moves that release money for the least projected loss.
   * Budget and club limits are enforced when moves are combined.
   */
  private candidateMoves(state: SquadState, gw: number): PlannedTransfer[] {
    const rem = this.remaining[gw];
    const candidates = this.candidatePool(gw, new Set(state.ids));
    const upgrades: Array<{ t: PlannedTransfer; gain: number }> = [];
    const funders: Array<{ t: PlannedTransfer; score: number }> = [];

    for (const outId of state.ids) {
      if (this.locked.has(outId)) continue;
      const out = this.players.get(outId)!;
      const sellPrice = state.sellPrices.get(outId)!;
      for (const inId of candidates[out.position]) {
        const buyPrice = this.players.get(inId)!.price;
        const t: PlannedTransfer = { playerOutId: outId, playerInId: inId, position: out.position, sellPrice, buyPrice };
        const gain = rem.get(inId)! - rem.get(outId)!;
        if (gain > 0) upgrades.push({ t, gain });
        const freed = sellPrice - buyPrice;
        if (freed > 0) funders.push({ t, score: freed / (1 + Math.max(0, -gain)) });
      }
    }

    const k = this.candidatesPerPosition * 2;
    upgrades.sort((a, b) => b.gain - a.gain);
    funders.sort((a, b) => b.score - a.score);
    const affordable = upgrades.filter((u) => this.comboFeasible(state, [u.t]));
    const unique = new Map<string, PlannedTransfer>();
    for (const t of [...affordable.slice(0, k), ...upgrades.slice(0, k), ...funders.slice(0, k / 2)].map(
      (x) => x.t
    )) {
      unique.set(`${t.playerOutId}>${t.playerInId}`, t);
    }
    return [...unique.values()];
  }

  /** Top replacement candidates per position: best projected and best value per £m. */
  private candidatePool(gw: number, owned: Set<number>): Record<Position, number[]> {
    const rem = this.remaining[gw];
    const pool: Record<Position, number[]> = {
      [Position.GKP]: [],
      [Position.DEF]: [],
      [Position.MID]: [],
      [Position.FWD]: [],
    };
    const byPos: Record<Position, OptimizerPlayer[]> = {
      [Position.GKP]: [],
      [Position.DEF]: [],
      [Position.MID]: [],
      [Position.FWD]: [],
    };
    for (const p of this.players.values()) {
      if (owned.has(p.id) || this.excluded.has(p.id) || rem.get(p.id)! <= 0) continue;
      byPos[p.position].push(p);
    }
    const k = this.candidatesPerPosition;
    for (const pos of Object.keys(byPos) as Position[]) {
      const list = byPos[pos];
      const best = [...list].sort((a, b) => rem.get(b.id)! - rem.get(a.id)! || a.id - b.id).slice(0, k);
      const value = [...list]
        .sort((a, b) => rem.get(b.id)! / b.price - rem.get(a.id)! / a.price || a.id - b.id)
        .slice(0, k);
      pool[pos] = [...new Set([...best, ...value].map((p) => p.id))];
    }
    return pool;
  }

  private comboFeasible(state: SquadState, combo: PlannedTransfer[]): boolean {
    const outs = new Set<number>();
    const ins = new Set<number>();
    let bank = state.bank;
    for (const t of combo) {
      if (outs.has(t.playerOutId) || ins.has(t.playerInId)) return false;
      outs.add(t.playerOutId);
      ins.add(t.playerInId);
      bank += t.sellPrice - t.buyPrice;
    }
    if (round1(bank) < 0) return false;
    const ids = state.ids.filter((id) => !outs.has(id)).concat([...ins]);
    for (const count of this.clubCounts(ids).values()) {
      if (count > SQUAD_RULES.MAX_PER_TEAM) return false;
    }
    return true;
  }

  private applyTransfers(state: SquadState, gw: number, combo: PlannedTransfer[]): SquadState {
    const outs = new Set(combo.map((t) => t.playerOutId));
    const ids = state.ids.filter((id) => !outs.has(id)).concat(combo.map((t) => t.playerInId));
    const sellPrices = new Map(state.sellPrices);
    let bank = state.bank;
    for (const t of combo) {
      sellPrices.delete(t.playerOutId);
      sellPrices.set(t.playerInId, t.buyPrice);
      bank += t.sellPrice - t.buyPrice;
    }
    bank = round1(bank);

    const hitCost = SquadService.calculateTransferCosts(combo.length, state.freeTransfers).reduce(
      (sum, c) => sum + c,
      0
    );
    const freeAfter = SquadService.rollFreeTransfers(Math.max(0, state.freeTransfers - combo.length), 1);
    const lineup = this.bestLineup(ids, gw);
    const netPoints = lineup.points - hitCost;
    const accumulated = state.accumulated + netPoints;

    return {
      ids,
      sellPrices,
      bank,
      freeTransfers: freeAfter,
      accumulated,
      bound: accumulated + this.holdPoints(ids, gw + 1),
      steps: [
        ...state.steps,
        {
          gameweekId: this.gameweekIds[gw],
          transfers: combo,
          freeTransfersAvailable: state.freeTransfers,
          hitCost,
          bankAfterTransfers: bank,
          projectedPoints: round2(lineup.points),
          netPoints: round2(netPoints),
          startingXI: lineup.startingXI,
          bench: lineup.bench,
          captainId: lineup.captainId,
          viceCaptainId: lineup.viceCaptainId,
          formation: lineup.formation,
        },
      ],
    };
  }

  private clubCounts(ids: number[]): Map<number, number> {
    const counts = new Map<number, number>();
    for (const id of ids) {
      const teamId = this.players.get(id)!.teamId;
      counts.set(teamId, (counts.get(teamId) ?? 0) + 1);
    }
    return counts;
  }

  /** Market value of the squad plus bank at the end of the horizon, £m. */
  private teamValue(ids: number[], bank: number): number {
    const gws = this.gameweekIds.length;
    const squadValue = ids.reduce((sum, id) => {
      const p = this.players.get(id)!;
      return sum + p.price + (p.predictedPriceChangePerGameweek ?? 0) * gws;
    }, 0);
    return round1(squadValue + bank);
  }

  private toPlan(state: SquadState, baselinePoints: number, baselineValue: number): TransferPlan {
    const projectedTeamValue = this.teamValue(state.ids, state.bank);
    return {
      gameweeks: state.steps,
      totalTransfers: state.steps.reduce((sum, s) => sum + s.transfers.length, 0),
      totalHitCost: state.steps.reduce((sum, s) => sum + s.hitCost, 0),
      projectedPoints: round2(state.accumulated),
      projectedScoreDelta: round2(state.accumulated - baselinePoints),
      projectedTeamValue,
      teamValueDelta: round1(projectedTeamValue - baselineValue),
      freeTransfersAfterHorizon: state.freeTransfers,
    };
  }

  /** Every planned gameweek must pass the same rules as a real squad submission. */
  private assertPlanValid(plan: TransferPlan): void {
    for (const step of plan.gameweeks) {
      const ids = [...step.startingXI, ...step.bench];
      const selections: SquadPlayerSelection[] = ids.map((playerId, idx) => ({
        playerId,
        positionOrder: idx + 1,
        isStarter: step.startingXI.includes(playerId),
        isCaptain: playerId === step.captainId,
        isViceCaptain: playerId === step.viceCaptainId,
      }));
      const validationPlayers = ids.map((id) => {
        const p = this.players.get(id)!;
        return { id, teamId: p.teamId, position: p.position, price: p.price };
      });
      const squadCost = validationPlayers.reduce((sum, p) => sum + p.price, 0);
      try {
        SquadValidator.validateSquad(selections, validationPlayers, round1(squadCost + step.bankAfterTransfers) + 0.05);
      } catch (err) {
        throw new TransferOptimizerError(
          `Planned squad for gameweek ${step.gameweekId} failed validation: ${(err as Error).message}`
        );
      }
    }
  }
}

export function solveTransferPlan(input: TransferPlanInput): TransferPlanResult {
  return new TransferOptimizerEngine(input).solve();
}
