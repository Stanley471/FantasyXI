import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { TransferConflictModal } from "../components/team/TransferConflictModal.js";
import type { MergeConflict, MergeResolutionMap } from "../lib/mergeResolver.js";

/** Issue #457: visual conflict resolution modal (server vs local draft). */

const CONFLICTS: MergeConflict[] = [
  {
    id: "price-changed-9",
    kind: "price-changed",
    playerId: 9,
    playerName: "Player9",
    message: "Player9 changed price from £5.0m to £8.0m while you were offline.",
    baseLabel: "Starter · £5.0m",
    localLabel: "Starter · £5.0m (draft price)",
    remoteLabel: "Starter · £8.0m",
    basePrice: 50,
    localPrice: 50,
    remotePrice: 80,
  },
  {
    id: "transferred-out-20",
    kind: "player-transferred-out",
    playerId: 20,
    playerName: "Player20",
    message: "Player20 was transferred out upstream while you were offline.",
    baseLabel: "Not in your squad",
    localLabel: "Transferred in · £6.0m",
    remoteLabel: "Not available",
    localPrice: 60,
  },
];

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
  setGlobal("navigator", dom.window.navigator);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

function renderModal(onResolve: (r: MergeResolutionMap) => void) {
  act(() =>
    root.render(
      <TransferConflictModal
        open
        conflicts={CONFLICTS}
        squadName="Draft XI"
        onResolve={onResolve}
        onCancel={() => {}}
      />
    )
  );
}

describe("TransferConflictModal (Issue #457)", () => {
  it("renders nothing when closed", () => {
    const markup = renderToStaticMarkup(
      <TransferConflictModal open={false} conflicts={CONFLICTS} onResolve={() => {}} onCancel={() => {}} />
    );
    assert.equal(markup, "");
  });

  it("renders both states for every conflict: server vs local draft", () => {
    const markup = renderToStaticMarkup(
      <TransferConflictModal open conflicts={CONFLICTS} squadName="Draft XI" onResolve={() => {}} onCancel={() => {}} />
    );
    assert.match(markup, /Resolve offline transfer conflicts/);
    assert.match(markup, /Draft XI/);
    assert.match(markup, /Player9/);
    assert.match(markup, /Player20/);
    assert.match(markup, /Price changed/);
    assert.match(markup, /Player transferred out/);
    assert.match(markup, /Your draft/);
    assert.match(markup, /Server/);
    assert.match(markup, /£8\.0m/);
    assert.match(markup, /£6\.0m/);
    assert.match(markup, /Not available/);
    assert.match(markup, /Apply resolutions/);
    assert.match(markup, /transfer-conflict-modal/);
  });

  it("marks the dialog as a modal for assistive tech", () => {
    const markup = renderToStaticMarkup(
      <TransferConflictModal open conflicts={CONFLICTS} onResolve={() => {}} onCancel={() => {}} />
    );
    assert.match(markup, /role="dialog"/);
    assert.match(markup, /aria-modal="true"/);
  });

  it("starts with safe defaults: keep the price change, drop the transferred-out player", () => {
    let received: MergeResolutionMap | null = null;
    renderModal((r) => {
      received = r;
    });
    const apply = container.querySelector('[data-testid="apply-resolutions"]') as HTMLButtonElement;
    act(() => apply.click());
    assert.deepEqual(received, { "price-changed-9": "mine", "transferred-out-20": "server" });
  });

  it("lets the manager flip a choice per conflict and fires the resolution callback", () => {
    let received: MergeResolutionMap | null = null;
    renderModal((r) => {
      received = r;
    });
    const serverButton = container.querySelector(
      '[data-testid="conflict-price-changed-9-server"]'
    ) as HTMLButtonElement;
    assert.equal(serverButton.getAttribute("aria-pressed"), "false");
    act(() => serverButton.click());
    assert.equal(serverButton.getAttribute("aria-pressed"), "true");
    const mineButton = container.querySelector(
      '[data-testid="conflict-transferred-out-20-mine"]'
    ) as HTMLButtonElement;
    act(() => mineButton.click());
    assert.equal(mineButton.getAttribute("aria-pressed"), "true");

    const apply = container.querySelector('[data-testid="apply-resolutions"]') as HTMLButtonElement;
    act(() => apply.click());
    assert.deepEqual(received, { "price-changed-9": "server", "transferred-out-20": "mine" });
  });

  it("calls onCancel when the manager decides later", () => {
    let cancelled = false;
    act(() =>
      root.render(
        <TransferConflictModal
          open
          conflicts={CONFLICTS}
          onResolve={() => {}}
          onCancel={() => {
            cancelled = true;
          }}
        />
      )
    );
    const cancel = container.querySelector('[data-testid="transfer-conflict-cancel"]') as HTMLButtonElement;
    act(() => cancel.click());
    assert.equal(cancelled, true);
  });
});
