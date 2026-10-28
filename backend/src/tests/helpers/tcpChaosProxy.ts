import net from "node:net";

export interface ChaosProxyOptions {
  targetPort: number;
  targetHost?: string;
  listenPort?: number;
}

export class TcpChaosProxy {
  private server: net.Server | null = null;
  private readonly targetPort: number;
  private readonly targetHost: string;
  private listenPort = 0;
  private clientSockets = new Set<net.Socket>();
  private targetSockets = new Set<net.Socket>();

  private latencyMs = 0;
  private dropPackets = false;
  private paused = false;

  constructor(options: ChaosProxyOptions) {
    this.targetPort = options.targetPort;
    this.targetHost = options.targetHost ?? "127.0.0.1";
    this.listenPort = options.listenPort ?? 0;
  }

  public async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((clientSocket) => {
        this.handleClient(clientSocket);
      });

      this.server.on("error", reject);

      this.server.listen(this.listenPort, "127.0.0.1", () => {
        const addr = this.server?.address();
        if (typeof addr === "object" && addr) {
          this.listenPort = addr.port;
          resolve(this.listenPort);
        } else {
          resolve(this.listenPort);
        }
      });
    });
  }

  public getPort(): number {
    return this.listenPort;
  }

  public getActiveConnectionCount(): number {
    return this.clientSockets.size;
  }

  public setLatency(latencyMs: number): void {
    this.latencyMs = latencyMs;
  }

  public setDropPackets(drop: boolean): void {
    this.dropPackets = drop;
  }

  public setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /**
   * Abruptly severs all active client and target TCP connections.
   * Simulates sudden database failover or TCP reset (ECONNRESET).
   */
  public severConnections(): void {
    for (const socket of this.clientSockets) {
      try {
        socket.destroy(new Error("ECONNRESET: TCP connection abruptly severed by chaos proxy"));
      } catch {
        // ignore
      }
    }
    for (const socket of this.targetSockets) {
      try {
        socket.destroy(new Error("ECONNRESET: Target connection abruptly severed"));
      } catch {
        // ignore
      }
    }
    this.clientSockets.clear();
    this.targetSockets.clear();
  }

  public async stop(): Promise<void> {
    this.severConnections();
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }
  }

  private handleClient(clientSocket: net.Socket): void {
    this.clientSockets.add(clientSocket);

    const targetSocket = new net.Socket();
    this.targetSockets.add(targetSocket);

    targetSocket.connect(this.targetPort, this.targetHost);

    // Forward client -> target
    clientSocket.on("data", (chunk) => {
      if (this.dropPackets) return;
      if (this.paused) return;

      if (this.latencyMs > 0) {
        setTimeout(() => {
          if (!targetSocket.destroyed) targetSocket.write(chunk);
        }, this.latencyMs);
      } else {
        targetSocket.write(chunk);
      }
    });

    // Forward target -> client
    targetSocket.on("data", (chunk) => {
      if (this.dropPackets) return;
      if (this.paused) return;

      if (this.latencyMs > 0) {
        setTimeout(() => {
          if (!clientSocket.destroyed) clientSocket.write(chunk);
        }, this.latencyMs);
      } else {
        clientSocket.write(chunk);
      }
    });

    const cleanup = () => {
      this.clientSockets.delete(clientSocket);
      this.targetSockets.delete(targetSocket);
      if (!clientSocket.destroyed) clientSocket.destroy();
      if (!targetSocket.destroyed) targetSocket.destroy();
    };

    clientSocket.on("close", cleanup);
    clientSocket.on("error", cleanup);
    targetSocket.on("close", cleanup);
    targetSocket.on("error", cleanup);
  }
}
