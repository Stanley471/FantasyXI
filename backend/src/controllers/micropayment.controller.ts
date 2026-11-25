import { Request, Response, NextFunction } from "express";
import {
  micropaymentChannelService,
  MicropaymentChannelError,
  type MicropaymentActionType,
} from "../services/financial/micropaymentChannelService.js";

function serializeChannel(channel: ReturnType<typeof micropaymentChannelService.getChannel>) {
  return {
    ...channel,
    depositStroops: channel.depositStroops.toString(),
    cumulativeSpentStroops: channel.cumulativeSpentStroops.toString(),
    remainingBalanceStroops: channel.remainingBalanceStroops.toString(),
    latestState: channel.latestState
      ? {
          ...channel.latestState,
          incrementStroops: channel.latestState.incrementStroops.toString(),
          cumulativeSpentStroops: channel.latestState.cumulativeSpentStroops.toString(),
          remainingBalanceStroops: channel.latestState.remainingBalanceStroops.toString(),
        }
      : null,
    stateHistory: channel.stateHistory.map((st) => ({
      ...st,
      incrementStroops: st.incrementStroops.toString(),
      cumulativeSpentStroops: st.cumulativeSpentStroops.toString(),
      remainingBalanceStroops: st.remainingBalanceStroops.toString(),
    })),
    disputes: channel.disputes.map((d) => ({
      ...d,
      resolvedCumulativeSpentStroops: d.resolvedCumulativeSpentStroops.toString(),
      resolvedRemainingBalanceStroops: d.resolvedRemainingBalanceStroops.toString(),
    })),
  };
}

export async function openMicropaymentChannelHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const { squadId, gameweekId, participantAddress, depositTxHash, depositStroops, channelId } =
      req.body ?? {};

    if (!squadId || !gameweekId || !participantAddress || !depositTxHash || depositStroops === undefined) {
      res.status(400).json({
        success: false,
        message: "squadId, gameweekId, participantAddress, depositTxHash, and depositStroops are required",
      });
      return;
    }

    const channel = micropaymentChannelService.openChannel({
      channelId,
      userId: req.user.id,
      squadId: String(squadId),
      gameweekId: Number(gameweekId),
      participantAddress: String(participantAddress),
      depositTxHash: String(depositTxHash),
      depositStroops,
    });

    res.status(201).json({
      success: true,
      data: serializeChannel(channel),
    });
  } catch (error) {
    if (error instanceof MicropaymentChannelError) {
      res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function getMicropaymentChannelHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const channelId = req.params.channelId as string;
    const channel = micropaymentChannelService.getChannel(channelId);
    res.status(200).json({
      success: true,
      data: serializeChannel(channel),
    });
  } catch (error) {
    if (error instanceof MicropaymentChannelError) {
      res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function applyMicropaymentStateUpdateHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const channelId = req.params.channelId as string;
    const {
      sequence,
      incrementStroops,
      cumulativeSpentStroops,
      actionType,
      actionPayload,
      signature,
    } = req.body ?? {};

    const updatedState = micropaymentChannelService.applyStateUpdate({
      channelId,
      sequence: Number(sequence),
      incrementStroops,
      cumulativeSpentStroops,
      actionType: (actionType || "LIVE_SUBSTITUTION") as MicropaymentActionType,
      actionPayload: actionPayload ?? {},
      signature: String(signature ?? ""),
    });

    res.status(200).json({
      success: true,
      data: {
        ...updatedState,
        incrementStroops: updatedState.incrementStroops.toString(),
        cumulativeSpentStroops: updatedState.cumulativeSpentStroops.toString(),
        remainingBalanceStroops: updatedState.remainingBalanceStroops.toString(),
      },
    });
  } catch (error) {
    if (error instanceof MicropaymentChannelError) {
      res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function disputeMicropaymentChannelHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const channelId = req.params.channelId as string;
    const {
      challengerAddress,
      sequence,
      cumulativeSpentStroops,
      actionType,
      payloadHash,
      participantSignature,
      platformCounterSignature,
    } = req.body ?? {};

    const disputeRecord = micropaymentChannelService.submitStateDispute({
      channelId,
      challengerAddress: String(challengerAddress ?? ""),
      sequence: Number(sequence),
      cumulativeSpentStroops,
      actionType: (actionType || "LIVE_SUBSTITUTION") as MicropaymentActionType,
      payloadHash: String(payloadHash ?? ""),
      participantSignature: String(participantSignature ?? ""),
      platformCounterSignature,
    });

    res.status(200).json({
      success: true,
      data: {
        ...disputeRecord,
        resolvedCumulativeSpentStroops: disputeRecord.resolvedCumulativeSpentStroops.toString(),
        resolvedRemainingBalanceStroops: disputeRecord.resolvedRemainingBalanceStroops.toString(),
      },
    });
  } catch (error) {
    if (error instanceof MicropaymentChannelError) {
      res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}

export async function settleGameweekMicropaymentChannelsHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const gameweekId = Number(req.params.gameweekId ?? req.body?.gameweekId);
    if (!Number.isInteger(gameweekId) || gameweekId <= 0) {
      res.status(400).json({ success: false, message: "A valid gameweekId is required" });
      return;
    }

    const result = await micropaymentChannelService.settleGameweekChannels(gameweekId);
    res.status(200).json({
      success: true,
      data: {
        ...result,
        totalCollectedFeeStroops: result.totalCollectedFeeStroops.toString(),
        totalRefundedStroops: result.totalRefundedStroops.toString(),
      },
    });
  } catch (error) {
    if (error instanceof MicropaymentChannelError) {
      res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message,
      });
      return;
    }
    next(error);
  }
}
