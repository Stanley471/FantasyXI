import { describe, it } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { countdownTone, formatCountdown, remainingUntil } from "../lib/countdown";
import { CountdownDisplay } from "../components/team/CountdownTimer";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatCountdown", () => {
  it("formats days, hours, minutes and seconds", () => {
    assert.equal(formatCountdown(2 * DAY + 14 * HOUR + 32 * MINUTE + 10 * SECOND), "2d 14h 32m 10s");
    assert.equal(formatCountdown(23 * HOUR + 59 * MINUTE + 59 * SECOND), "0d 23h 59m 59s");
    assert.equal(formatCountdown(59 * MINUTE + 1 * SECOND), "0d 0h 59m 1s");
    assert.equal(formatCountdown(999), "0d 0h 0m 0s");
  });

  it("clamps zero and negative durations to the zero state", () => {
    assert.equal(formatCountdown(0), "0d 0h 0m 0s");
    assert.equal(formatCountdown(-5 * SECOND), "0d 0h 0m 0s");
  });
});

describe("countdownTone", () => {
  it("turns amber under 24 hours and red under 1 hour", () => {
    assert.equal(countdownTone(DAY), "normal");
    assert.equal(countdownTone(DAY - 1), "amber");
    assert.equal(countdownTone(HOUR), "amber");
    assert.equal(countdownTone(HOUR - 1), "red");
    assert.equal(countdownTone(1), "red");
    assert.equal(countdownTone(0), "expired");
  });
});

describe("remainingUntil", () => {
  it("never goes negative once the deadline has passed", () => {
    const deadline = "2026-01-01T12:00:00.000Z";
    const at = Date.parse(deadline);
    assert.equal(remainingUntil(deadline, at - 90 * SECOND), 90 * SECOND);
    assert.equal(remainingUntil(deadline, at + 1), 0);
    assert.equal(remainingUntil("not-a-date", at), 0);
  });
});

describe("CountdownDisplay", () => {
  it("renders the formatted countdown with its tone", () => {
    const markup = renderToStaticMarkup(<CountdownDisplay remainingMs={30 * MINUTE + 5 * SECOND} />);
    assert.match(markup, /0d 0h 30m 5s/);
    assert.match(markup, /data-tone="red"/);
  });

  it("renders the squad locked badge at zero", () => {
    const markup = renderToStaticMarkup(<CountdownDisplay remainingMs={0} />);
    assert.match(markup, /Deadline Passed - Squad Locked/);
    assert.doesNotMatch(markup, /deadline-countdown/);
  });
});
