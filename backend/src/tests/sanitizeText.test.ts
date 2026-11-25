import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizePlainText } from "../lib/sanitizeText.js";

describe("sanitizePlainText (issue #493)", () => {
  it("strips script tags and their body entirely", () => {
    assert.equal(
      sanitizePlainText('Great league! <script>alert("xss")</script> Join now.'),
      "Great league!  Join now."
    );
  });

  it("strips style tags and their body", () => {
    assert.equal(
      sanitizePlainText("Welcome <style>body{display:none}</style> managers"),
      "Welcome  managers"
    );
  });

  it("strips iframe tags but keeps no body (self-closing/empty)", () => {
    assert.equal(
      sanitizePlainText('Check this out <iframe src="javascript:alert(1)"></iframe> please'),
      "Check this out  please"
    );
  });

  it("strips anchor tags but keeps their visible text", () => {
    assert.equal(
      sanitizePlainText('Visit <a href="javascript:alert(1)">our site</a> for details'),
      "Visit our site for details"
    );
  });

  it("strips image tags with onerror handlers", () => {
    assert.equal(
      sanitizePlainText('<img src=x onerror=alert(1)>Welcome'),
      "Welcome"
    );
  });

  it("strips svg/onload payloads", () => {
    assert.equal(sanitizePlainText("<svg/onload=alert(1)>Hi"), "Hi");
  });

  it("defeats nested-tag bypass tricks via a fixed-point pass", () => {
    // The inner "<script>ipt>alert(1)</script>" is a complete, matchable
    // script block and is removed; what's left ("<scr") is inert text with
    // no closing bracket, so it is never executable markup.
    assert.equal(sanitizePlainText("<scr<script>ipt>alert(1)</script>"), "<scr");
    assert.doesNotMatch(sanitizePlainText("<scr<script>ipt>alert(1)</script>"), /alert\(1\)/);
  });

  it("leaves plain text completely unchanged, with no character corruption", () => {
    const plain = "Premier Office League 2026/27 — Friends, family & office rivals! 50/50 split.";
    assert.equal(sanitizePlainText(plain), plain);
  });

  it("preserves unicode and punctuation exactly", () => {
    const plain = "¡Vamos equipo! 100% effort, no <3 for cheaters — café included ☕";
    assert.equal(sanitizePlainText(plain), plain);
  });

  it("passes non-string input through unchanged", () => {
    assert.equal(sanitizePlainText(null as unknown as string), null);
    assert.equal(sanitizePlainText(undefined as unknown as string), undefined);
  });
});
