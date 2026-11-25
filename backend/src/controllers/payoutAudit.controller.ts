import type { NextFunction, Request, Response } from "express";
import { payoutAuditAnchorService } from "../services/audit/payoutAuditAnchorService.js";

export async function verifyPayoutAudit(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const entryId = typeof req.query.entryId === "string" ? req.query.entryId : undefined;
    const result = await payoutAuditAnchorService.verify(entryId);
    res.status(result.valid ? 200 : 409).json({ success: result.valid, data: result });
  } catch (error) {
    next(error);
  }
}
