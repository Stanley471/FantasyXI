import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { copyToClipboard } from "../lib/clipboard";
import { CopyButton } from "../components/ui/CopyButton";

const URL_TO_COPY = "https://fantasyxi.app/leagues/invite/abc123";

let dom: JSDOM;
let root: Root;
let container: HTMLElement;
let written: string[];

function setGlobal(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  written = [];
  setGlobal("window", dom.window);
  setGlobal("document", dom.window.document);
  setGlobal("navigator", {
    clipboard: { writeText: async (text: string) => void written.push(text) },
  });
  setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  dom.window.close();
});

function render() {
  act(() => root.render(<CopyButton value={URL_TO_COPY} ariaLabel="Copy invitation link" />));
  return container.querySelector("button") as HTMLButtonElement;
}

describe("CopyButton", () => {
  it("is an accessible native button (Enter/Space operable)", () => {
    const button = render();
    assert.equal(button.tagName, "BUTTON");
    assert.equal(button.getAttribute("type"), "button");
    assert.equal(button.getAttribute("aria-label"), "Copy invitation link");
  });

  it("copies the full URL and shows transient feedback", async () => {
    const button = render();
    const status = () => container.querySelector('[role="status"]')!;
    assert.equal(status().getAttribute("aria-live"), "polite");
    assert.equal(status().textContent, "");

    await act(async () => {
      button.click();
    });

    assert.deepEqual(written, [URL_TO_COPY]);
    assert.match(container.textContent ?? "", /Copied!/);
    assert.equal(status().textContent, "Copied to clipboard!");
  });
});

describe("copyToClipboard", () => {
  it("falls back to execCommand when the Clipboard API is unavailable", async () => {
    setGlobal("navigator", {});
    let selected = "";
    const doc = document as Document & { execCommand: (command: string) => boolean };
    doc.execCommand = (command: string) => {
      selected = (document.activeElement as HTMLTextAreaElement | null)?.value ?? "";
      return command === "copy";
    };
    const realCreate = document.createElement.bind(document);
    doc.createElement = ((tag: string) => {
      const el = realCreate(tag);
      if (tag === "textarea") (el as HTMLTextAreaElement).select = () => el.focus();
      return el;
    }) as Document["createElement"];

    assert.equal(await copyToClipboard(URL_TO_COPY), true);
    assert.equal(selected, URL_TO_COPY);
    assert.equal(document.querySelectorAll("textarea").length, 0);
  });
});
