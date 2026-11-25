import { Router } from "express";
import {
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  clearAllNotifications,
} from "../controllers/notification.controller.js";
import { requireAuth } from "../middleware/authMiddleware.js";
import { authenticatedRateLimiter } from "../middleware/rateLimiter.js";

const router = Router();

router.use(requireAuth, authenticatedRateLimiter);

router.get("/", listNotifications);
router.post("/read-all", markAllNotificationsRead);
router.post("/:id/read", markNotificationRead);
router.delete("/", clearAllNotifications);

export default router;
