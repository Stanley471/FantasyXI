import { Router } from "express";
import {
  createEndpoint,
  listEndpoints,
  testDispatch,
  listDeliveries,
} from "../controllers/webhook.controller.js";

const router = Router();

router.post("/endpoints", createEndpoint);
router.get("/endpoints", listEndpoints);
router.post("/endpoints/:id/test", testDispatch);
router.get("/endpoints/:id/deliveries", listDeliveries);

export default router;
