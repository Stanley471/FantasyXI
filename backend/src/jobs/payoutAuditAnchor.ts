import { payoutAuditAnchorService } from "../services/audit/payoutAuditAnchorService.js";

export async function anchorPayoutAuditRoot() {
  return payoutAuditAnchorService.anchorCurrentRoot();
}
