import type { Request, Response } from "express";
import {
  getFxRateOracle,
  isSupportedCryptoAsset,
  StaleRateError,
  VolatilityLockError,
  type FxRateOracle,
} from "../services/financial/fxRateOracle.js";

export function createFxOracleHandlers(oracleProvider: () => FxRateOracle = getFxRateOracle) {
  const getRate = async (req: Request, res: Response): Promise<void> => {
    const assetRaw = String(req.query.asset ?? "USDC").toUpperCase();
    const fiat = String(req.query.fiat ?? "USD").toUpperCase();

    if (!isSupportedCryptoAsset(assetRaw)) {
      res.status(400).json({
        success: false,
        message: `Unsupported crypto asset: ${assetRaw}. Supported assets: USDC, ZEC`,
      });
      return;
    }

    try {
      const result = await oracleProvider().getRate(assetRaw, fiat);
      if (result.freshness === "STALE_REVALIDATING") {
        res.setHeader("X-Data-Stale", "true");
      }
      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      if (err instanceof StaleRateError) {
        res.status(503).json({
          success: false,
          code: err.code,
          message: err.message,
          staleAgeMs: err.staleAgeMs,
        });
        return;
      }
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : "Failed to fetch FX rate",
      });
    }
  };

  const convertEntryFee = async (req: Request, res: Response): Promise<void> => {
    const { fiatAmount, asset: assetRaw, fiat = "USD", acceptedRateToken } = req.body ?? {};
    const asset = String(assetRaw ?? "").toUpperCase();

    if (!isSupportedCryptoAsset(asset)) {
      res.status(400).json({
        success: false,
        message: `Unsupported crypto asset: ${asset}. Supported assets: USDC, ZEC`,
      });
      return;
    }

    const numericAmount = Number(fiatAmount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
      res.status(400).json({
        success: false,
        message: "fiatAmount must be a positive number",
      });
      return;
    }

    try {
      const conversion = await oracleProvider().convertFiatToCrypto(
        numericAmount,
        asset,
        String(fiat).toUpperCase(),
        { acceptedRateToken: typeof acceptedRateToken === "string" ? acceptedRateToken : undefined },
      );

      if (conversion.freshness === "STALE_REVALIDATING") {
        res.setHeader("X-Data-Stale", "true");
      }

      res.status(200).json({
        success: true,
        data: conversion,
      });
    } catch (err) {
      if (err instanceof VolatilityLockError) {
        res.status(409).json({
          success: false,
          code: err.code,
          data: err.details,
          message: err.message,
        });
        return;
      }
      if (err instanceof StaleRateError) {
        res.status(503).json({
          success: false,
          code: err.code,
          message: err.message,
          staleAgeMs: err.staleAgeMs,
        });
        return;
      }
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : "Failed to convert entry fee",
      });
    }
  };

  const getOracleStatus = (_req: Request, res: Response): void => {
    res.status(200).json({
      success: true,
      data: oracleProvider().getStatus(),
    });
  };

  return { getRate, convertEntryFee, getOracleStatus };
}

const defaultHandlers = createFxOracleHandlers();
export const getFxRate = defaultHandlers.getRate;
export const convertFxEntryFee = defaultHandlers.convertEntryFee;
export const getFxOracleStatus = defaultHandlers.getOracleStatus;
