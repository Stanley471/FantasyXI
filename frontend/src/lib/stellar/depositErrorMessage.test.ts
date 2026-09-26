import { describe, it, expect } from "vitest";
import { mapDepositErrorToMessage } from "./depositErrorMessage";
import { SorobanDepositTimeoutError } from "./sorobanDeposit";

describe("mapDepositErrorToMessage", () => {
  it("maps a Freighter rejection to a friendly message", () => {
    expect(mapDepositErrorToMessage(new Error("User declined access"))).toBe(
      "Signature request was rejected in the selected wallet."
    );
    expect(mapDepositErrorToMessage(new Error("Transaction rejected by user"))).toBe(
      "Signature request was rejected in the selected wallet."
    );
  });

  it("maps insufficient balance / trustline errors", () => {
    expect(
      mapDepositErrorToMessage(new Error("Contract simulation failed: missing trustline"))
    ).toBe("Insufficient Testnet USDC balance or missing trustline in Freighter.");
    expect(mapDepositErrorToMessage(new Error("balance too low"))).toBe(
      "Insufficient Testnet USDC balance or missing trustline in Freighter."
    );
  });

  it("maps network/connectivity failures", () => {
    expect(
      mapDepositErrorToMessage(new Error("Failed to load account GABC123"))
    ).toBe("Could not reach the Stellar network. Check your connection and retry.");
    expect(mapDepositErrorToMessage(new Error("NetworkError when attempting to fetch"))).toBe(
      "Could not reach the Stellar network. Check your connection and retry."
    );
  });

  it("falls back to the raw message for unrecognized errors", () => {
    expect(mapDepositErrorToMessage(new Error("Some unexpected contract error"))).toBe(
      "Some unexpected contract error"
    );
  });

  it("stringifies non-Error values", () => {
    expect(mapDepositErrorToMessage("plain string failure")).toBe("plain string failure");
  });
});

describe("SorobanDepositTimeoutError", () => {
  it("carries the transaction hash so a retry can re-check status without resubmitting", () => {
    const err = new SorobanDepositTimeoutError("abc123txhash");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SorobanDepositTimeoutError");
    expect(err.txHash).toBe("abc123txhash");
    expect(err.message).toMatch(/could not confirm its status/);
  });
});
