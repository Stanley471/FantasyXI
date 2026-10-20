import type { ChatHub, ChatMessageDto, ChatPubSubAdapter } from "./chatService.js";
import { eventFanout, type EventFanout } from "../live/eventFanout.js";

/** Chat remains persisted in PostgreSQL; a dropped live frame is recovered from history. */
export class StreamChatAdapter implements ChatPubSubAdapter {
  private readonly rooms = new Map<string, () => void>();
  constructor(private readonly hub: ChatHub, private readonly fanout: EventFanout = eventFanout) {}
  publish(message: ChatMessageDto): void {
    this.fanout.publish(`chat:${message.leagueId}`, message.id, { message });
  }
  subscribeLeague(leagueId: string): void {
    if (this.rooms.has(leagueId)) return;
    this.rooms.set(leagueId, this.fanout.subscribe(`chat:${leagueId}`, (frame) => {
      for (const event of frame.events) {
        if (event.origin !== this.fanout.instanceId) this.hub.broadcastLocal(event.data.message as ChatMessageDto);
      }
    }));
  }
  unsubscribeLeague(leagueId: string): void { this.rooms.get(leagueId)?.(); this.rooms.delete(leagueId); }
  close(): void { for (const unsubscribe of this.rooms.values()) unsubscribe(); this.rooms.clear(); }
}
