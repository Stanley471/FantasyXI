import { Request, Response, NextFunction } from "express";
import {
  multiChainAccountLinkerService,
  MultiChainWalletError,
  type SupportedChain,
} from "../services/auth/multiChainAccountLinkerService.js";

export async function createWalletLinkChallengeHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const { chain, address, networkId } = req.body ?? {};
    const challenge = multiChainAccountLinkerService.issueLinkChallenge({
      userId: req.user.id,
      chain: String(chain ?? "").toUpperCase() as SupportedChain,
      address: String(address ?? ""),
      networkId: networkId ? String(networkId) : undefined,
    });

    res.status(200).json({
      success: true,
      data: challenge,
    });
  } catch (error) {
    if (error instanceof MultiChainWalletError) {
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

export async function verifyAndLinkWalletHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const { chain, address, message, signature, publicKey, providerName, label, networkId } =
      req.body ?? {};

    const linked = multiChainAccountLinkerService.verifyAndLinkWallet({
      userId: req.user.id,
      chain: String(chain ?? "").toUpperCase() as SupportedChain,
      address: String(address ?? ""),
      message: String(message ?? ""),
      signature: String(signature ?? ""),
      publicKey: publicKey ? String(publicKey) : undefined,
      providerName: providerName ? String(providerName) : undefined,
      label: label ? String(label) : undefined,
      networkId: networkId ? String(networkId) : undefined,
    });

    res.status(201).json({
      success: true,
      message: "Wallet address verified and linked successfully",
      data: linked,
    });
  } catch (error) {
    if (error instanceof MultiChainWalletError) {
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

export async function listLinkedWalletsHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const wallets = multiChainAccountLinkerService.listUserWallets(req.user.id);
    res.status(200).json({
      success: true,
      data: wallets,
    });
  } catch (error) {
    next(error);
  }
}

export async function renameLinkedWalletHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const walletId = req.params.walletId as string;
    const { label } = req.body ?? {};
    const updated = multiChainAccountLinkerService.renameWallet(
      req.user.id,
      walletId,
      String(label ?? "")
    );

    res.status(200).json({
      success: true,
      data: updated,
    });
  } catch (error) {
    if (error instanceof MultiChainWalletError) {
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

export async function unlinkWalletHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!req.user?.id) {
      res.status(401).json({ success: false, message: "Authentication required" });
      return;
    }

    const walletId = req.params.walletId as string;
    multiChainAccountLinkerService.unlinkWallet(req.user.id, walletId);

    res.status(200).json({
      success: true,
      message: "Wallet address unlinked",
    });
  } catch (error) {
    if (error instanceof MultiChainWalletError) {
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
