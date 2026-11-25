import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Position } from "../types";
import {
  PositionBadge,
  POSITION_COLOR_TOKENS,
  getPositionColorToken,
  normalizePositionCode,
  calculateContrastRatio,
} from "../components/ui/PositionBadge";

let dom: JSDOM;
let root: Root;
let container: HTMLElement;

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

describe("PositionBadge & Standardized Design Tokens (Issue #481)", () => {
  it("maps GKP, DEF, MID, and FWD to standardized Amber, Blue, Green, and Red tokens", () => {
    const gkp = getPositionColorToken(Position.GKP);
    const def = getPositionColorToken(Position.DEF);
    const mid = getPositionColorToken(Position.MID);
    const fwd = getPositionColorToken(Position.FWD);

    assert.ok(gkp);
    assert.equal(gkp.colorFamily, "Amber");
    assert.equal(gkp.bgVar, "var(--pos-gkp-bg, #b45309)");

    assert.ok(def);
    assert.equal(def.colorFamily, "Blue");
    assert.equal(def.bgVar, "var(--pos-def-bg, #1d4ed8)");

    assert.ok(mid);
    assert.equal(mid.colorFamily, "Green");
    assert.equal(mid.bgVar, "var(--pos-mid-bg, #15803d)");

    assert.ok(fwd);
    assert.equal(fwd.colorFamily, "Red");
    assert.equal(fwd.bgVar, "var(--pos-fwd-bg, #b91c1c)");
  });

  it("satisfies WCAG AA contrast standards (>= 4.5:1) for all position badges", () => {
    for (const [code, token] of Object.entries(POSITION_COLOR_TOKENS)) {
      const ratio = calculateContrastRatio(token.bgHex, token.fgHex);
      assert.ok(
        ratio >= 4.5,
        `Expected ${code} (${token.colorFamily}) contrast ratio ${ratio.toFixed(2)} to be >= 4.5:1`
      );
    }
  });

  it("normalizes case-insensitive position strings and rejects invalid codes", () => {
    assert.equal(normalizePositionCode("gkp"), "GKP");
    assert.equal(normalizePositionCode(" DEF "), "DEF");
    assert.equal(normalizePositionCode("mid"), "MID");
    assert.equal(normalizePositionCode("FWD"), "FWD");
    assert.equal(normalizePositionCode("UNKNOWN"), null);
    assert.equal(getPositionColorToken("INVALID"), null);
  });

  it("renders consistent PositionBadge DOM attributes and design token styles for all positions", () => {
    act(() => {
      root.render(
        <div>
          <PositionBadge position={Position.GKP} size="sm" />
          <PositionBadge position={Position.DEF} size="md" />
          <PositionBadge position="MID" />
          <PositionBadge position="FWD" />
          <PositionBadge position="SUB" />
        </div>
      );
    });

    const badges = container.querySelectorAll('[data-testid="position-badge"]');
    assert.equal(badges.length, 5);

    assert.equal(badges[0].textContent, "GKP");
    assert.equal(badges[0].getAttribute("data-position"), "GKP");
    assert.equal(badges[0].getAttribute("data-color-family"), "amber");

    assert.equal(badges[1].textContent, "DEF");
    assert.equal(badges[1].getAttribute("data-position"), "DEF");
    assert.equal(badges[1].getAttribute("data-color-family"), "blue");
    assert.match(badges[1].className, /text-xs/);

    assert.equal(badges[2].textContent, "MID");
    assert.equal(badges[2].getAttribute("data-position"), "MID");
    assert.equal(badges[2].getAttribute("data-color-family"), "green");

    assert.equal(badges[3].textContent, "FWD");
    assert.equal(badges[3].getAttribute("data-position"), "FWD");
    assert.equal(badges[3].getAttribute("data-color-family"), "red");

    // Fallback for unrecognized code
    assert.equal(badges[4].textContent, "SUB");
    assert.equal(badges[4].getAttribute("data-position"), "SUB");
    assert.equal(badges[4].getAttribute("data-color-family"), null);
  });
});
