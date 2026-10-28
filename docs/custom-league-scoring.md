# Custom league scoring

Private leagues can use a scoring preset or provide a complete rule config in
the league creation request. Omitting both keeps the existing platform-wide
FPL scoring path and does not create league-specific score records.

```json
{
  "name": "Community Rules",
  "entryFee": 0,
  "startGameweekId": 1,
  "endGameweekId": 38,
  "squadId": "creator-squad-id",
  "scoringPreset": "DEFENSIVE_MASTERMIND"
}
```

Available presets are `CLASSIC_FPL`, `ALL_ATTACK`, and
`DEFENSIVE_MASTERMIND`. To customize a rule set, send `scoringConfig` instead
of `scoringPreset`:

```json
{
  "version": 1,
  "appearance": { "underSixtyMinutes": 1, "sixtyOrMoreMinutes": 2 },
  "goals": { "GKP": 8, "DEF": 7, "MID": 5, "FWD": 4 },
  "assists": 3,
  "cleanSheets": { "GKP": 6, "DEF": 6, "MID": 1, "FWD": 0 },
  "goalsConcededPerTwo": { "GKP": -1, "DEF": -1, "MID": 0, "FWD": 0 },
  "savesPerThree": 1,
  "penaltySaves": 6,
  "penaltyMisses": -2,
  "yellowCards": -1,
  "redCards": -3,
  "ownGoals": -2,
  "bonus": 1
}
```

Each weight must be an integer from -100 to 100. Goal, assist, clean-sheet,
appearance, save, penalty-save, and bonus rewards cannot be negative.
Goals-conceded, missed-penalty, card, and own-goal weights cannot be positive.
`goalsConcededPerTwo` is applied for each complete pair of goals conceded.
Rules are validated before league creation; a league cannot submit both a
preset and a custom config.

Custom points are computed from per-gameweek player event stats and stored in
`league_gameweek_scores`, isolated by league, squad, and gameweek. This keeps
global squad/public league scores unchanged while allowing independent rules
for parallel private leagues.

After installing backend dependencies, run the scoring unit tests with:

```powershell
cd backend
npx tsx --test src/tests/scoringService.test.ts src/tests/fplNormalizer.test.ts
npm run bench:scoring
```
