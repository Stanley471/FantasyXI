import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CopyInviteButton,
  copyToClipboardWithFallback,
  COPY_TOOLTIP_DURATION_MS,
} from "../components/leagues/CopyInviteButton";

describe("CopyInviteButton & Clipboard Fallback (#246)", () => {
  it("copies full invitation URL via navigator.clipboard.writeText when available", async () => {
    let copiedText = "";
    const globalAny = globalThis as Record<string, unknown>;
    const prevNavigator = globalAny.navigator;

    Object.defineProperty(globalThis, "navigator", {
      value: {
        clipboard: {
          writeText: async (text: string) => {
            copiedText = text;
          },
        },
      },
      configurable: true,
      writable: true,
    });

    try {
      const inviteUrl = "https://fantasyxi.app/leagues/invite/inv_9f8e7d6c5b4a";
      const ok = await copyToClipboardWithFallback(inviteUrl);
      assert.equal(ok, true);
      assert.equal(copiedText, inviteUrl);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: prevNavigator,
        configurable: true,
        writable: true,
      });
    }
  });

  it("falls back to document.execCommand('copy') when navigator.clipboard fails or is unavailable", async () => {
    let execCommandCalled = false;
    let appendedValue = "";
    const globalAny = globalThis as Record<string, unknown>;
    const prevNavigator = globalAny.navigator;
    const prevDocument = globalAny.document;

    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });

    const mockTextarea = {
      value: "",
      style: {} as Record<string, string>,
      setAttribute() {},
      focus() {},
      select() {},
    };

    Object.defineProperty(globalThis, "document", {
      value: {
        createElement: (tag: string) => {
          assert.equal(tag, "textarea");
          return mockTextarea;
        },
        body: {
          appendChild: (el: typeof mockTextarea) => {
            appendedValue = el.value;
          },
          removeChild: () => {},
        },
        execCommand: (cmd: string) => {
          if (cmd === "copy") {
            execCommandCalled = true;
            return true;
          }
          return false;
        },
      },
      configurable: true,
      writable: true,
    });

    try {
      const url = "https://fantasyxi.app/leagues/invite/fallback_token_123";
      const ok = await copyToClipboardWithFallback(url);
      assert.equal(ok, true);
      assert.equal(execCommandCalled, true);
      assert.equal(appendedValue, url);
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        value: prevNavigator,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(globalThis, "document", {
        value: prevDocument,
        configurable: true,
        writable: true,
      });
    }
  });

  it("renders accessible aria-label='Copy invitation link' and ARIA live region in idle and copied states", () => {
    assert.equal(COPY_TOOLTIP_DURATION_MS, 2000);

    const idleHtml = renderToStaticMarkup(
      <CopyInviteButton valueToCopy="https://fantasyxi.app/leagues/invite/tok1" />
    );
    assert.match(idleHtml, /aria-label="Copy invitation link"/);
    assert.match(idleHtml, /role="status"/);
    assert.match(idleHtml, /aria-live="polite"/);
    assert.doesNotMatch(idleHtml, /Copied to clipboard!/);

    const copiedHtml = renderToStaticMarkup(
      <CopyInviteButton
        valueToCopy="https://fantasyxi.app/leagues/invite/tok1"
        initialCopied={true}
      />
    );
    assert.match(copiedHtml, /aria-label="Copy invitation link"/);
    assert.match(copiedHtml, /Copied!/);
    assert.match(copiedHtml, /role="tooltip"/);
    assert.match(copiedHtml, /Copied to clipboard!/);
  });
});
