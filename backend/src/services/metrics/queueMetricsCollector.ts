import { bullQueueDepth, bullQueueProcessingCount, bullJobDuration } from "../../config/metrics.js";

/**
 * Collects metrics from BullMQ job queues.
 * Tracks queue depth (pending jobs) and processing status.
 */
export class QueueMetricsCollector {
  /**
   * Update queue depth metrics from a BullMQ Queue instance.
   * Call periodically (e.g., every 10-30 seconds) to keep metrics fresh.
   */
  static async updateQueueMetrics(queue: any): Promise<void> {
    try {
      const queueName = queue.name || "unknown";
      
      // Get queue counts
      const counts = await queue.getJobCounts();
      const pending = counts.waiting || 0;
      const active = counts.active || 0;
      
      bullQueueDepth.labels(queueName).set(pending);
      bullQueueProcessingCount.labels(queueName).set(active);
    } catch (error) {
      console.warn("[metrics] Failed to update queue metrics:", error);
    }
  }

  /**
   * Record job completion time.
   */
  static recordJobDuration(queueName: string, durationMs: number, status: "success" | "failed"): void {
    bullJobDuration.labels(queueName, status).observe(durationMs);
  }
}
