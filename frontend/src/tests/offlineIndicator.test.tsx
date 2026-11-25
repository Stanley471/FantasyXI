import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { OfflineIndicator } from "../components/layout/OfflineIndicator";

let dom: JSDOM;
let root: Root;
let container: HTMLElement;
let toastEvents: Array<{ message: string; type: string }>;

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function setOnline(value: boolean) {
  Object.defineProperty(dom.window.navigator, "onLine", {
    value,
    configurable: true,
  });
  dom.window.dispatchEvent(new dom.window.Event(value ? "online" : "offline"));
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fantasyxi.app" });
  toastEvents = [];
  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("navigator", dom.window.navigator);
  setGlobal("CustomEvent", dom.window.CustomEvent);
  setGlobal("Event", dom.window.Event);
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  dom.window.addEventListener("fantasyxi:toast", (e: Event) => {
    const detail = (e as CustomEvent).detail;
    toastEvents.push({ message: detail.message, type: detail.type });
  });
  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

describe("OfflineIndicator", () => {
  it("shows the offline banner immediately when the browser goes offline", () => {
    setOnline(true);
    act(() => root.render(<OfflineIndicator />));
    assert.equal(container.querySelector('[role="status"]'), null);

    act(() => setOnline(false));
    const banner = container.querySelector('[role="status"]');
    assert.ok(banner);
    assert.match(banner!.textContent ?? "", /You are offline/);
  });

  it("dismisses the banner and emits a 'Back online' toast on reconnection", () => {
    setOnline(false);
    act(() => root.render(<OfflineIndicator />));
    assert.ok(container.querySelector('[role="status"]'));

    act(() => setOnline(true));

    assert.equal(container.querySelector('[role="status"]'), null);
    assert.deepEqual(toastEvents, [{ message: "Back online", type: "success" }]);
  });
});
