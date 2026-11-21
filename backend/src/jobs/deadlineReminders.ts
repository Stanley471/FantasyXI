import { prisma } from "../config/db.js";
import { emailService } from "../services/email/emailService.js";

const REMINDER_LEAD_HOURS = 6;

/**
 * Deadline Reminder Job.
 *
 * Sends an automated email reminder to opted-in managers 6 hours before
 * the gameweek deadline. Includes their active squad lineup and upcoming fixtures.
 *
 * Deduplication: Uses GameweekDeadlineReminder table to ensure each manager
 * receives at most one reminder per gameweek.
 *
 * Returns the count of reminders sent.
 */
export async function sendGameweekDeadlineReminders(now: Date = new Date()): Promise<number> {
  // Find gameweeks approaching their deadline (within 6 hours)
  const sixHoursFromNow = new Date(now.getTime() + REMINDER_LEAD_HOURS * 60 * 60 * 1000);

  const gameweeks = await prisma.gameweek.findMany({
    where: {
      isFinished: false,
      isLocked: false,
      deadline: {
        gte: now,
        lte: sixHoursFromNow,
      },
    },
    include: {
      fixtures: {
        where: { finished: false },
        select: {
          homeTeam: { select: { name: true, shortName: true } },
          awayTeam: { select: { name: true, shortName: true } },
          kickoffTime: true,
        },
      },
    },
  });

  let sentCount = 0;

  for (const gameweek of gameweeks) {
    // Find all active league members who opted-in to deadline reminders
    const members = await prisma.leagueMember.findMany({
      where: {
        status: "ACTIVE",
        user: {
          deadlineReminder: true,
        },
      },
      include: {
        user: {
          select: { id: true, email: true, username: true, name: true },
        },
        squad: {
          include: {
            players: {
              include: {
                player: {
                  select: {
                    displayName: true,
                    position: true,
                    price: true,
                    totalPoints: true,
                  },
                },
              },
              orderBy: { isStarter: "desc" },
            },
          },
        },
        league: {
          select: { name: true, inviteCode: true },
        },
      },
    });

    for (const member of members) {
      // Check if we've already sent a reminder for this user in this gameweek
      const existingReminder = await prisma.gameweekDeadlineReminder.findUnique({
        where: {
          userId_gameweekId: {
            userId: member.userId,
            gameweekId: gameweek.id,
          },
        },
      });

      if (existingReminder) {
        continue; // Already sent for this gameweek
      }

      try {
        // Build squad lineup summary
        const starters = member.squad.players.filter((sp) => sp.isStarter);
        const benchPlayers = member.squad.players.filter((sp) => !sp.isStarter);
        const captainPlayer = member.squad.players.find((sp) => sp.isCaptain);
        const viceCaptainPlayer = member.squad.players.find((sp) => sp.isViceCaptain);

        // Build fixtures summary
        const fixturesSummary = gameweek.fixtures
          .slice(0, 5)
          .map((f) => `${f.homeTeam.shortName} vs ${f.awayTeam.shortName}`)
          .join(", ");

        const teamUrl = `${(process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/$/, "")}/league/${member.league.inviteCode}/team/${member.squadId}`;

        // Send email via emailService
        const result = await emailService.sendDeadlineReminder({
          to: member.user.email,
          managerName: member.user.name || member.user.username,
          leagueName: member.league.name,
          gameweekName: gameweek.name,
          deadline: gameweek.deadline,
          startersCount: starters.length,
          benchCount: benchPlayers.length,
          captainName: captainPlayer?.player.displayName || "Not set",
          viceCaptainName: viceCaptainPlayer?.player.displayName || "Not set",
          squadName: member.squad.name,
          teamManagementUrl: teamUrl,
          upcomingFixturesSummary: fixturesSummary,
        });

        if (result.success) {
          // Record that reminder was sent
          await prisma.gameweekDeadlineReminder.create({
            data: {
              userId: member.userId,
              gameweekId: gameweek.id,
            },
          });

          sentCount++;
          console.log(
            `[deadline-reminders] Sent reminder to ${member.user.email} for GW${gameweek.fplId}`
          );
        } else {
          console.error(
            `[deadline-reminders] Failed to send reminder to ${member.user.email}: ${result.error}`
          );
        }
      } catch (error) {
        console.error(
          `[deadline-reminders] Error processing reminder for user ${member.userId}:`,
          error
        );
      }
    }
  }

  return sentCount;
}
