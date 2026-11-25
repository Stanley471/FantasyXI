import { Router } from "express";
import {
  createFxOracleHandlers,
  getFxOracleStatus,
  getFxRate,
  convertFxEntryFee,
} from "../controllers/fxOracle.controller.js";
import type { FxRateOracle } from "../services/financial/fxRateOracle.js";

export function createFxOracleRouter(oracleProvider?: () => FxRateOracle): Router {
  const router = Router();
  const handlers = oracleProvider
    ? createFxOracleHandlers(oracleProvider)
    : { getRate: getFxRate, convertEntryFee: convertFxEntryFee, getOracleStatus: getFxOracleStatus };

  router.get("/rate", handlers.getRate);
  router.post("/convert", handlers.convertEntryFee);
  router.get("/status", handlers.getOracleStatus);

  return router;
}

export default createFxOracleRouter();
