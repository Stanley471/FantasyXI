import { Request, Response, NextFunction } from "express";
import { prisma } from "../config/db.js";

export async function getLedgerAuditReports(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const requestedLimit = Number(req.query.limit ?? 20);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 20;
    const reports = await prisma.ledgerAuditRun.findMany({
      take: limit,
      orderBy: { createdAt: "desc" },
      include: { findings: { orderBy: { createdAt: "asc" } } },
    });
    res.json({ success: true, data: reports });
  } catch (error) {
    next(error);
  }
}
