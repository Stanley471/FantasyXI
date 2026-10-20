import { prisma } from "../../config/db.js";
import { EmailService, emailService } from "../email/emailService.js";
import { eventBus, EventBus } from "./eventBus.js";
import {
  CAPTAIN_INJURY_ALERT_EVENT,
  CaptainInjuryAlertPayload,
} from "./domainEvents.js";

const ALERT_RATE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000;
const recentAlerts = new Map<string, number>();

function normalizeStatusLabel(status: string): string {
  switch (status) {
    case "d":
      return "doubtful";
    case "i":
      return "injured";
    case "s":
      return "suspended";
    default:
      return "unavailable";
  }
}

async function handleCaptainInjuryAlert(
  payload: CaptainInjuryAlertPayload,
  _event?: unknown
): Promise<void> {
  const dedupeKey = `${payload.gameweekId ?? "unknown"}:${payload.playerId}:${payload.status}:${(
    payload.news ?? ""
  )
    .trim()
    .toLowerCase()}`;
  const lastSentAt = recentAlerts.get(dedupeKey);
  const now = Date.now();

  if (lastSentAt && now - lastSentAt < ALERT_RATE_LIMIT_MS) {
    return;
  }

  const captainNodes = await prisma.squadPlayer.findMany({
    where: {
      playerId: payload.playerId,
      isCaptain: true,
    },
    include: {
      squad: {
        include: {
          user: {
            select: {
              id: true,
              email: true,
              username: true,
              name: true,
            },
          },
        },
      },
    },
  });

  if (captainNodes.length === 0) {
    recentAlerts.set(dedupeKey, now);
    return;
  }

  const managerEmail = new EmailService(emailService.getProvider());

  for (const captainNode of captainNodes) {
    const manager = captainNode.squad.user;
    if (!manager.email) continue;

    const teamManagementUrl = "https://fantasyxi.app/team";
    const result = await managerEmail.sendCaptainInjuryAlert({
      to: manager.email,
      managerName: manager.name || manager.username,
      captainName: payload.captainName,
      status: payload.status,
      news: payload.news ?? undefined,
      teamManagementUrl,
    });

    if (result.success) {
      recentAlerts.set(dedupeKey, now);
    }
  }
}

export const CAPTAIN_INJURY_HANDLER_NAMES = [
  "emailService.dispatchCaptainInjuryAlerts",
] as const;

let registeredOnDefaultBus = false;

export function registerCaptainInjuryEventHandlers(bus: EventBus = eventBus): void {
  if (bus === eventBus) {
    if (registeredOnDefaultBus) return;
    registeredOnDefaultBus = true;
  }

  bus.subscribe(CAPTAIN_INJURY_ALERT_EVENT, handleCaptainInjuryAlert, {
    name: CAPTAIN_INJURY_HANDLER_NAMES[0],
  });
}

registerCaptainInjuryEventHandlers();
