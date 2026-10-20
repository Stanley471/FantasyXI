export interface BoundedSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  terminate(): void;
}
/** Both bytes queued in ws and outstanding frames count toward the bound. */
export class BoundedSocketSender {
  private pending = 0;
  private dropped = 0;
  constructor(private readonly socket: BoundedSocket, private readonly maxFrames = 32,
    private readonly maxBytes = 256 * 1024, private readonly maxDrops = 3) {}
  send(payload: unknown): boolean {
    if (this.socket.readyState !== 1) return false;
    const text = JSON.stringify(payload);
    if (this.pending >= this.maxFrames || this.socket.bufferedAmount + Buffer.byteLength(text) > this.maxBytes) {
      if (++this.dropped >= this.maxDrops) this.socket.terminate();
      return false;
    }
    this.dropped = 0;
    this.pending++;
    try {
      this.socket.send(text, (error) => { this.pending--; if (error) this.socket.terminate(); });
    } catch { this.pending--; this.socket.terminate(); return false; }
    return true;
  }
}
