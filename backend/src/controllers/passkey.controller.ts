import { Request, Response, NextFunction } from "express";
import {
  webauthnService,
  WebAuthnConflictError,
  WebAuthnNotFoundError,
  WebAuthnValidationError,
  WebAuthnVerificationError,
} from "../services/auth/webauthnService.js";

/**
 * WebAuthn / passkey endpoints (issue #273). Ceremony options are returned in
 * the JSON shape expected by navigator.credentials.create() / .get() helpers
 * (e.g. @simplewebauthn/browser), and responses are posted back the same way.
 */

function sendPasskeyError(error: unknown, res: Response): boolean {
  const status =
    error instanceof WebAuthnValidationError ? 400
    : error instanceof WebAuthnVerificationError ? 401
    : error instanceof WebAuthnNotFoundError ? 404
    : error instanceof WebAuthnConflictError ? 409
    : null;
  if (status === null) return false;
  res.status(status).json({ success: false, message: (error as Error).message });
  return true;
}

function requireUserId(req: Request, res: Response): string | null {
  if (!req.user?.id) {
    res.status(401).json({ success: false, message: "Authentication required" });
    return null;
  }
  return req.user.id;
}

/** POST /api/v1/auth/passkeys/register/options (Protected) */
export async function passkeyRegistrationOptions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    res.json({ success: true, data: await webauthnService.startRegistration(userId) });
  } catch (error) {
    if (!sendPasskeyError(error, res)) next(error);
  }
}

/** POST /api/v1/auth/passkeys/register/verify (Protected) body: { response, name? } */
export async function passkeyRegistrationVerify(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const passkey = await webauthnService.finishRegistration(userId, req.body?.response, req.body?.name);
    res.status(201).json({ success: true, message: "Passkey registered", data: passkey });
  } catch (error) {
    if (!sendPasskeyError(error, res)) next(error);
  }
}

/** GET /api/v1/auth/passkeys (Protected) */
export async function listPasskeys(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    res.json({ success: true, data: await webauthnService.listPasskeys(userId) });
  } catch (error) {
    next(error);
  }
}

/** DELETE /api/v1/auth/passkeys/:id (Protected) */
export async function deletePasskey(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    await webauthnService.deletePasskey(userId, req.params.id as string);
    res.json({ success: true, message: "Passkey removed" });
  } catch (error) {
    if (!sendPasskeyError(error, res)) next(error);
  }
}

/** PUT /api/v1/auth/passkeys/mfa (Protected) body: { enabled, currentPassword } */
export async function setPasskeyMfa(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const userId = requireUserId(req, res);
    if (!userId) return;
    const data = await webauthnService.setMfaEnabled(userId, req.body?.enabled, req.body?.currentPassword);
    res.json({ success: true, data });
  } catch (error) {
    if (!sendPasskeyError(error, res)) next(error);
  }
}

/** POST /api/v1/auth/passkeys/login/options body: { email? } */
export async function passkeyLoginOptions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ success: true, data: await webauthnService.startAuthentication(req.body?.email) });
  } catch (error) {
    if (!sendPasskeyError(error, res)) next(error);
  }
}

/** POST /api/v1/auth/passkeys/login/verify body: { response } */
export async function passkeyLoginVerify(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await webauthnService.finishAuthentication(req.body?.response, {
      ip: req.ip ?? req.socket.remoteAddress ?? "unknown",
      userAgent: req.headers["user-agent"] ?? null,
    });
    res.json({ success: true, message: "Logged in successfully", data: result });
  } catch (error) {
    if (!sendPasskeyError(error, res)) next(error);
  }
}

/** POST /api/v1/auth/passkeys/mfa/options body: { mfaToken } */
export async function passkeyMfaOptions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ success: true, data: await webauthnService.startMfa(req.body?.mfaToken) });
  } catch (error) {
    if (!sendPasskeyError(error, res)) next(error);
  }
}

/** POST /api/v1/auth/passkeys/mfa/verify body: { mfaToken, response } */
export async function passkeyMfaVerify(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await webauthnService.finishMfa(req.body?.mfaToken, req.body?.response);
    res.json({ success: true, message: "Logged in successfully", data: result });
  } catch (error) {
    if (!sendPasskeyError(error, res)) next(error);
  }
}
