import { Request, Response, NextFunction } from "express";
import {
  chatService,
  ChatForbiddenError,
  ChatNotFoundError,
  ChatRateLimitError,
  ChatValidationError,
} from "../services/chat/chatService.js";

/**
 * Maps chat domain errors to HTTP responses; returns false for unknown errors.
 */
function sendChatError(error: unknown, res: Response): boolean {
  if (error instanceof ChatValidationError) {
    res.status(400).json({ success: false, message: error.message });
    return true;
  }
  if (error instanceof ChatForbiddenError) {
    res.status(403).json({ success: false, message: error.message });
    return true;
  }
  if (error instanceof ChatNotFoundError) {
    res.status(404).json({ success: false, message: error.message });
    return true;
  }
  if (error instanceof ChatRateLimitError) {
    res.setHeader("Retry-After", Math.ceil(error.retryAfterMs / 1000).toString());
    res.status(429).json({ success: false, message: error.message, retryAfterMs: error.retryAfterMs });
    return true;
  }
  return false;
}

/**
 * GET /api/v1/leagues/:leagueId/chat/messages?before=<messageId>&limit=50
 * Chat history in chronological order (members and creator only).
 */
export async function getChatMessages(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { before, limit } = req.query;
    if (before !== undefined && typeof before !== "string") {
      res.status(400).json({ success: false, message: "before must be a message id" });
      return;
    }
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      res.status(400).json({ success: false, message: "limit must be a positive integer" });
      return;
    }

    const page = await chatService.getHistory(req.params.leagueId as string, req.user!.id, {
      before,
      limit: parsedLimit,
    });
    res.json({ success: true, data: page.messages, meta: { hasMore: page.hasMore } });
  } catch (error) {
    if (sendChatError(error, res)) return;
    next(error);
  }
}

/**
 * POST /api/v1/leagues/:leagueId/chat/messages  { body }
 * HTTP fallback for posting when the WebSocket is unavailable; broadcasts like a socket message.
 */
export async function postChatMessage(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const message = await chatService.postMessage(req.params.leagueId as string, req.user!.id, req.body?.body);
    res.status(201).json({ success: true, data: message });
  } catch (error) {
    if (sendChatError(error, res)) return;
    next(error);
  }
}
