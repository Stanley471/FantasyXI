import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { getFocusableElements, createFocusTrapHandler } from "../lib/focusTrap";

let dom: JSDOM;
let document: Document;

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function buildDrawer() {
  document.body.innerHTML = `
    <button id="toggle">Open menu</button>
    <div id="drawer" tabindex="-1">
      <button id="close">Close</button>
      <a id="link-1" href="/a">Dashboard</a>
      <a id="link-2" href="/b">Leagues</a>
      <button id="logout">Sign Out</button>
    </div>
    <a id="background-link" href="/background">Background link</a>
  `;
  return document.getElementById("drawer") as HTMLElement;
}

function dispatchKey(target: EventTarget, key: string, options: { shiftKey?: boolean } = {}) {
  const event = new dom.window.KeyboardEvent("keydown", {
    key,
    shiftKey: options.shiftKey ?? false,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://fantasyxi.app" });
  document = dom.window.document;
  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("KeyboardEvent", dom.window.KeyboardEvent);
});

afterEach(() => {
  dom.window.close();
});

describe("getFocusableElements", () => {
  it("lists only visible, enabled focusable elements inside a container", () => {
    const drawer = buildDrawer();
    const close = document.createElement("button");
    close.disabled = true;
    close.textContent = "Disabled";
    drawer.appendChild(close);

    const ids = getFocusableElements(drawer).map((el) => el.id);
    assert.deepEqual(ids, ["close", "link-1", "link-2", "logout"]);
  });
});

describe("createFocusTrapHandler", () => {
  it("wraps Tab forward from the last element back to the first", () => {
    const drawer = buildDrawer();
    document.body.addEventListener("keydown", createFocusTrapHandler(drawer, () => {}));
    const last = document.getElementById("logout")!;
    last.focus();

    const event = dispatchKey(last, "Tab", {});

    assert.equal(event.defaultPrevented, true);
    assert.equal(document.activeElement?.id, "close");
  });

  it("wraps Shift+Tab backward from the first element to the last", () => {
    const drawer = buildDrawer();
    document.body.addEventListener("keydown", createFocusTrapHandler(drawer, () => {}));
    const close = document.getElementById("close")!;
    close.focus();

    const event = dispatchKey(close, "Tab", { shiftKey: true });

    assert.equal(event.defaultPrevented, true);
    assert.equal(document.activeElement?.id, "logout");
  });

  it("pulls focus back inside the drawer if it somehow lands on a background element", () => {
    const drawer = buildDrawer();
    document.body.addEventListener("keydown", createFocusTrapHandler(drawer, () => {}));
    const background = document.getElementById("background-link")!;
    background.focus();

    const event = dispatchKey(background, "Tab", {});

    assert.equal(event.defaultPrevented, true);
    assert.equal(document.activeElement?.id, "close");
  });

  it("leaves focus untouched for keys other than Tab or Escape", () => {
    const drawer = buildDrawer();
    document.body.addEventListener("keydown", createFocusTrapHandler(drawer, () => {}));
    const link = document.getElementById("link-1")!;
    link.focus();

    const event = dispatchKey(link, "Enter", {});

    assert.equal(event.defaultPrevented, false);
    assert.equal(document.activeElement?.id, "link-1");
  });

  it("calls onEscape and prevents default when Escape is pressed", () => {
    const drawer = buildDrawer();
    let escaped = 0;
    document.body.addEventListener("keydown", createFocusTrapHandler(drawer, () => escaped++));
    const close = document.getElementById("close")!;
    close.focus();

    const event = dispatchKey(close, "Escape", {});

    assert.equal(event.defaultPrevented, true);
    assert.equal(escaped, 1);
  });
});
