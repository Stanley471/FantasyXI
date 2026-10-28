import { Router } from "express";
import { requireAuth } from "../middleware/authMiddleware.js";
import {
  createEndpoint,
  listEndpoints,
  testDispatch,
  listDeliveries,
  getDeadLetterDeliveries,
  retryFailedDelivery,
  reactivateEndpointController,
} from "../controllers/webhook.controller.js";

const router = Router();

router.post("/endpoints", requireAuth, createEndpoint);
router.get("/endpoints", listEndpoints);
router.post("/endpoints/:id/test", testDispatch);
router.get("/endpoints/:id/deliveries", listDeliveries);
router.post("/endpoints/:id/reactivate", reactivateEndpointController);

router.get("/dead-letter", getDeadLetterDeliveries);
router.post("/retry", retryFailedDelivery);

export default router;
