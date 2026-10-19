import { Request, Response } from "express";
import {
  leagueAuditService,
  LeagueAuditPackage,
} from "../services/audit/leagueAuditService.js";

/**
 * Parses optional gameweek query param.
 */
function parseGameweekQuery(gw: unknown): number | undefined {
  if (typeof gw === "string" && gw.trim() !== "" && !isNaN(Number(gw))) {
    return parseInt(gw, 10);
  }
  return undefined;
}

/**
 * GET /api/v1/leagues/:id/audit/seal
 * Returns the SHA-256 Merkle integrity seal for the league and optional gameweek.
 */
export async function getLeagueAuditSeal(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const gameweek = parseGameweekQuery(req.query.gameweek);

    const pkg = await leagueAuditService.generateAuditPackage(id, gameweek);

    res.json({
      success: true,
      leagueId: pkg.league.id,
      leagueName: pkg.league.name,
      gameweek: pkg.gameweek,
      seal: pkg.seal,
    });
  } catch (error: any) {
    res.status(error.message?.includes("not found") ? 404 : 500).json({
      success: false,
      error: error.message || "Failed to generate league integrity seal",
    });
  }
}

/**
 * GET /api/v1/leagues/:id/audit/export/json
 * Downloads deterministic canonical JSON audit package with verification instructions.
 */
export async function exportLeagueAuditJson(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const gameweek = parseGameweekQuery(req.query.gameweek);

    const pkg = await leagueAuditService.generateAuditPackage(id, gameweek);
    const filename = `league_${id}_gw_${pkg.gameweek}_audit.json`;

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(JSON.stringify(pkg, null, 2));
  } catch (error: any) {
    res.status(error.message?.includes("not found") ? 404 : 500).json({
      success: false,
      error: error.message || "Failed to export league audit JSON",
    });
  }
}

/**
 * GET /api/v1/leagues/:id/audit/export/pdf
 * Downloads cryptographically sealed PDF audit certificate.
 */
export async function exportLeagueAuditPdf(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const gameweek = parseGameweekQuery(req.query.gameweek);

    const pkg = await leagueAuditService.generateAuditPackage(id, gameweek);
    const pdfBuffer = leagueAuditService.generatePdfCertificate(pkg);
    const filename = `league_${id}_gw_${pkg.gameweek}_certificate.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdfBuffer.length.toString());
    res.send(pdfBuffer);
  } catch (error: any) {
    res.status(error.message?.includes("not found") ? 404 : 500).json({
      success: false,
      error: error.message || "Failed to export league audit PDF certificate",
    });
  }
}

/**
 * POST /api/v1/leagues/:id/audit/verify
 * Validates an uploaded/submitted audit package against tampering.
 */
export async function verifyLeagueAuditPackage(req: Request, res: Response): Promise<void> {
  try {
    const pkg = req.body as LeagueAuditPackage;
    if (!pkg || !pkg.seal || !Array.isArray(pkg.events)) {
      res.status(400).json({
        success: false,
        valid: false,
        error: "Invalid audit package payload: expected 'seal' and 'events' fields",
      });
      return;
    }

    const result = leagueAuditService.verifyAuditPackage(pkg);

    if (result.valid) {
      res.json({
        success: true,
        valid: true,
        totalEvents: result.totalEvents,
        verifiedEvents: result.verifiedEvents,
        merkleRoot: result.merkleRoot,
      });
    } else {
      res.status(400).json({
        success: false,
        valid: false,
        totalEvents: result.totalEvents,
        verifiedEvents: result.verifiedEvents,
        tamperedIndex: result.tamperedIndex,
        corruptEventId: result.corruptEventId,
        error: result.error,
      });
    }
  } catch (error: any) {
    res.status(500).json({
      success: false,
      valid: false,
      error: error.message || "Verification encountered an internal error",
    });
  }
}
