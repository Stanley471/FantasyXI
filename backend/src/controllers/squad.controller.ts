import { Request, Response, NextFunction } from "express";
import {
  squadService,
  SquadForbiddenError,
  ChipUnavailableError,
} from "../services/squad/squadService.js";
import {
  SquadValidationError,
  SquadLockedError,
} from "../services/squad/squadValidator.js";
import { scoringService } from "../services/scoring/scoringService.js";

/**
 * Squad Controller.
 *
 * Handles creation, updates, validation, and scoring calculation for user fantasy squads.
 *
 * Laravel equivalent: Like app/Http/Controllers/SquadController.php using
 * dedicated FormRequests and SquadService with authorization checks.
 */

export async function createSquad(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required to create a squad",
      });
      return;
    }

    // Always derive userId from authenticated token — ignore client-supplied userId
    const squad = await squadService.createSquad({
      ...req.body,
      userId: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: "Fantasy squad created successfully",
      data: squad,
    });
  } catch (error) {
    if (error instanceof SquadValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
        errors: { squad: error.errors },
      });
      return;
    }
    next(error);
  }
}

export async function getSquadById(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const squad = await squadService.getSquad(id as string);
    res.json({
      success: true,
      data: squad,
    });
  } catch (error) {
    if (error instanceof SquadValidationError) {
      res.status(404).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function updateSquad(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required to update squad",
      });
      return;
    }

    const { id } = req.params;
    // Pass authenticated user ID for ownership verification
    const squad = await squadService.updateSquad(
      id as string,
      req.body,
      req.user.id
    );

    res.json({
      success: true,
      message: "Squad updated successfully",
      data: squad,
    });
  } catch (error) {
    if (error instanceof SquadForbiddenError) {
      res.status(403).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error instanceof SquadLockedError) {
      res.status(403).json({
        success: false,
        message: error.message,
        deadline: error.deadline,
      });
      return;
    }
    if (error instanceof SquadValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
        errors: { squad: error.errors },
      });
      return;
    }
    next(error);
  }
}

export async function getMySquads(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required",
      });
      return;
    }

    const squads = await squadService.getUserSquads(req.user.id);
    res.json({
      success: true,
      data: squads,
    });
  } catch (error) {
    next(error);
  }
}

export async function getUserSquads(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { userId } = req.params;
    const squads = await squadService.getUserSquads(userId as string);
    res.json({
      success: true,
      data: squads,
    });
  } catch (error) {
    next(error);
  }
}

export async function getSquadValuation(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id } = req.params;
    const valuation = await squadService.getSquadValuation(id as string);
    res.json({
      success: true,
      data: valuation,
    });
  } catch (error) {
    if (error instanceof SquadValidationError) {
      res.status(404).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function calculateGameweekScore(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { id, gameweekId } = req.params;
    const parsedGw = parseInt(gameweekId as string, 10);
    if (isNaN(parsedGw)) {
      res.status(400).json({
        success: false,
        message: "Invalid gameweek ID",
      });
      return;
    }

    const result = await scoringService.calculateAndPersistSquadScore(
      id as string,
      parsedGw
    );

    res.json({
      success: true,
      message: `Score calculated for gameweek ${parsedGw}`,
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function activateChip(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user || !req.user.id) {
      res.status(401).json({
        success: false,
        message: "Authentication required to play a chip",
      });
      return;
    }

    const { id } = req.params;
    const { chipType, gameweekId } = req.body;
    const parsedGw = parseInt(gameweekId, 10);
    if (!chipType || isNaN(parsedGw)) {
      res.status(400).json({
        success: false,
        message: "chipType and a numeric gameweekId are required",
      });
      return;
    }

    const usage = await squadService.activateChip(
      id as string,
      chipType,
      parsedGw,
      req.user.id
    );

    res.status(201).json({
      success: true,
      message: `${chipType} activated for gameweek ${parsedGw}`,
      data: usage,
    });
  } catch (error) {
    if (error instanceof SquadForbiddenError) {
      res.status(403).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error instanceof SquadLockedError) {
      res.status(403).json({
        success: false,
        message: error.message,
        deadline: error.deadline,
      });
      return;
    }
    if (error instanceof ChipUnavailableError) {
      res.status(409).json({
        success: false,
        message: error.message,
      });
      return;
    }
    if (error instanceof SquadValidationError) {
      res.status(400).json({
        success: false,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}
