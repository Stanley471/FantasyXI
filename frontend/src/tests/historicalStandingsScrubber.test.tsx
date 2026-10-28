import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { useState } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { HistoricalStandingsScrubber } from "../components/leagues/HistoricalStandingsScrubber";
import type { LeagueStandingsEntry } from "../types";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Event: dom.window.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const weeks = [{ id: 1, name: "Gameweek 1" }, { id: 2, name: "Gameweek 2" }];
const standingsFor = (squadName: string): LeagueStandingsEntry[] => [{
  rank: 1,
  userId: "user-1",
  username: "manager",
  squadId: "squad-1",
  squadName,
  membershipStatus: "ACTIVE" as LeagueStandingsEntry["membershipStatus"],
  totalPoints: 10,
  bestGameweekPoints: 10,
  gameweekScores: [],
  joinedAt: "2026-01-01T00:00:00Z",
}];

describe("HistoricalStandingsScrubber", () => {
  it("changes the displayed standings when the completed gameweek slider moves", async () => {
    const rootElement = document.getElementById("root")!;
    const root = createRoot(rootElement);
    function Harness() {
      const [selected, setSelected] = useState(1);
      return <HistoricalStandingsScrubber
        gameweeks={weeks}
        selectedGameweekId={selected}
        standings={standingsFor(selected === 1 ? "First Week FC" : "Second Week FC")}
        onSelectGameweek={setSelected}
      />;
    }

    await act(async () => { root.render(<Harness />); });
    assert.match(rootElement.textContent ?? "", /First Week FC/);
    const slider = rootElement.querySelector<HTMLInputElement>("input[type=range]")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(slider, "1");
      slider.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.match(rootElement.textContent ?? "", /Second Week FC/);
    await act(async () => root.unmount());
  });
});
