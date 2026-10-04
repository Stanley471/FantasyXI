import { Request, Response } from "express";
import { prisma } from "../config/db.js";
import { Transaction } from "@stellar/stellar-sdk";

export const getStellarToml = async (req: Request, res: Response) => {
  const toml = `
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
AUTHORIZATION_SERVER="\${process.env.BACKEND_URL || "http://localhost:5000"}/api/v1/sep8"

[[CURRENCIES]]
code="USDC"
issuer="GBBD47IF6LWK7P7MDEVSCWTTCJMMA2OSLTAUUWHGHUSVNCRJCVEP2ZDI"
status="live"
is_asset_anchored=true
anchor_asset_type="fiat"
anchor_asset="USD"
regulated=true
  `;
  res.setHeader("Content-Type", "text/plain");
  res.send(toml.trim());
};

export const submitKycData = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { firstName, lastName, documentId } = req.body;
    
    if (!firstName || !lastName || !documentId) {
      return res.status(400).json({ success: false, message: "Missing KYC data" });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        kycStatus: "PENDING",
        kycData: { firstName, lastName, documentId },
        kycSubmittedAt: new Date()
      } as any
    });

    res.json({ success: true, status: (updatedUser as any).kycStatus });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const getKycStatus = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    res.json({ success: true, status: (user as any).kycStatus });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
};

export const txApprove = async (req: Request, res: Response) => {
  try {
    const txBase64 = (req.query.tx || req.body.tx) as string;
    if (!txBase64) {
      return res.status(400).json({ error: "Missing tx parameter" });
    }

    try {
      const tx = new Transaction(txBase64, "Test SDF Network ; September 2015");
      const sourceAccount = tx.source;

      const wallet = await prisma.wallet.findUnique({
        where: { stellarAddress: sourceAccount },
        include: { user: true }
      });

      if (!wallet || !wallet.user) {
        return res.status(403).json({
          status: "rejected",
          error: "Unrecognized wallet address. User must register and complete KYC."
        });
      }

      if ((wallet.user as any).kycStatus !== "APPROVED") {
        return res.status(403).json({
          status: "pending",
          error: "KYC verification pending or rejected.",
          pending: 100 // time in seconds to check back
        });
      }

      // If approved, sign it (in reality, we'd sign with an issuer secret key)
      // For this implementation, we just return the tx in success
      return res.json({
        status: "success",
        tx: txBase64,
        message: "Transaction approved."
      });
    } catch (parseErr) {
      return res.status(400).json({ error: "Invalid transaction format" });
    }

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};
