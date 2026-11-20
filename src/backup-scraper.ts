import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

/**
 * Backup scraper service that maintains fallback data sources
 * Implements multiple fallback strategies:
 * 1. Secondary API provider
 * 2. Local filesystem cache
 * 3. Emergency fallback data
 */
export class BackupScraper {
  private backupApiUrl: string;
  private fallbackCachePath: string;
  private axiosInstance: AxiosInstance;

  private lastFallbackCache: unknown;
  private fallbackCacheUpdateTime: number = 0;

  constructor(backupApiUrl: string, fallbackCachePath: string, backupTimeoutMs: number = 5000) {
    this.backupApiUrl = backupApiUrl;
    this.fallbackCachePath = fallbackCachePath;

    this.axiosInstance = axios.create({
      baseURL: this.backupApiUrl,
      timeout: backupTimeoutMs,
    });

    // Load existing fallback cache
    this.loadFallbackCache();

    logger.info(
      { backupApiUrl, fallbackCachePath },
      'Backup scraper initialized'
    );
  }

  /**
   * Fetch data from backup API provider
   */
  public async fetchFromBackupAPI(endpoint: string): Promise<unknown> {
    try {
      logger.debug({ endpoint }, 'Fetching from backup API');

      const startTime = Date.now();
      const response = await this.axiosInstance.get(endpoint);
      const responseTimeMs = Date.now() - startTime;

      logger.info(
        { endpoint, statusCode: response.status, responseTimeMs },
        'Backup API fetch successful'
      );

      // Update fallback cache with backup data
      this.updateFallbackCache(response.data);

      return response.data;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ endpoint, error: errorMessage }, 'Backup API fetch failed');
      throw error;
    }
  }

  /**
   * Fetch from local fallback cache
   */
  public async fetchFromFallbackCache(): Promise<unknown> {
    if (!this.lastFallbackCache) {
      logger.warn('No fallback cache available');
      return null;
    }

    const cacheAgeMins = (Date.now() - this.fallbackCacheUpdateTime) / 1000 / 60;
    logger.info({ cacheAgeMins: cacheAgeMins.toFixed(2) }, 'Using fallback cache');

    return this.lastFallbackCache;
  }

  /**
   * Load fallback cache from filesystem
   */
  private loadFallbackCache(): void {
    try {
      if (!fs.existsSync(this.fallbackCachePath)) {
        logger.warn({ path: this.fallbackCachePath }, 'Fallback cache file does not exist');
        return;
      }

      const data = fs.readFileSync(this.fallbackCachePath, 'utf-8');
      const parsed = JSON.parse(data);
      this.lastFallbackCache = parsed;
      this.fallbackCacheUpdateTime = Date.now();

      logger.info({ path: this.fallbackCachePath }, 'Fallback cache loaded from filesystem');
    } catch (error) {
      logger.error(
        { path: this.fallbackCachePath, error },
        'Failed to load fallback cache'
      );
    }
  }

  /**
   * Update fallback cache with new data
   */
  private updateFallbackCache(data: unknown): void {
    try {
      // Ensure directory exists
      const dir = path.dirname(this.fallbackCachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Write to file
      fs.writeFileSync(this.fallbackCachePath, JSON.stringify(data, null, 2));
      this.lastFallbackCache = data;
      this.fallbackCacheUpdateTime = Date.now();

      logger.debug({ path: this.fallbackCachePath }, 'Fallback cache updated');
    } catch (error) {
      logger.error(
        { path: this.fallbackCachePath, error },
        'Failed to update fallback cache'
      );
    }
  }

  /**
   * Get available data from any fallback source
   * Tries in order: backup API, then fallback cache
   */
  public async getAvailableBackupData(endpoint: string): Promise<unknown> {
    // Try backup API first
    try {
      const backupData = await this.fetchFromBackupAPI(endpoint);
      if (backupData) {
        return backupData;
      }
    } catch (error) {
      logger.warn('Backup API unavailable, falling back to cache');
    }

    // Fall back to local cache
    const cachedData = await this.fetchFromFallbackCache();
    if (cachedData) {
      return cachedData;
    }

    // Return minimal emergency data
    logger.error('All backup sources exhausted, returning minimal emergency data');
    return this.getEmergencyFallbackData();
  }

  /**
   * Emergency fallback data structure
   * This represents a minimal but valid FPL response to keep scoring pipeline operational
   */
  private getEmergencyFallbackData(): unknown {
    return {
      events: [
        {
          id: 0,
          name: 'Emergency Fallback',
          deadline_time: new Date().toISOString(),
          is_current: true,
          status: 'provisional',
        },
      ],
      teams: [
        { id: 1, name: 'Arsenal', code: 3, short_name: 'ARS' },
        { id: 2, name: 'Aston Villa', code: 7, short_name: 'AVL' },
        { id: 3, name: 'Bournemouth', code: 91, short_name: 'BOU' },
        { id: 4, name: 'Brentford', code: 94, short_name: 'BRE' },
        { id: 5, name: 'Brighton', code: 131, short_name: 'BHA' },
        { id: 6, name: 'Chelsea', code: 8, short_name: 'CHE' },
        { id: 7, name: 'Crystal Palace', code: 9, short_name: 'CRY' },
        { id: 8, name: 'Everton', code: 11, short_name: 'EVE' },
        { id: 9, name: 'Fulham', code: 54, short_name: 'FUL' },
        { id: 10, name: 'Ipswich Town', code: 40, short_name: 'IPS' },
        { id: 11, name: 'Leicester City', code: 13, short_name: 'LEI' },
        { id: 12, name: 'Liverpool', code: 14, short_name: 'LIV' },
        { id: 13, name: 'Manchester City', code: 43, short_name: 'MCI' },
        { id: 14, name: 'Manchester United', code: 1, short_name: 'MUN' },
        { id: 15, name: 'Newcastle United', code: 4, short_name: 'NEW' },
        { id: 16, name: 'Nottingham Forest', code: 17, short_name: 'NFO' },
        { id: 17, name: 'Southampton', code: 20, short_name: 'SOU' },
        { id: 18, name: 'Tottenham Hotspur', code: 6, short_name: 'TOT' },
        { id: 19, name: 'West Ham United', code: 21, short_name: 'WHU' },
        { id: 20, name: 'Wolverhampton Wanderers', code: 39, short_name: 'WOL' },
      ],
      elements: [], // Empty for emergency mode
      element_types: [
        { id: 1, plural_name: 'Goalkeepers' },
        { id: 2, plural_name: 'Defenders' },
        { id: 3, plural_name: 'Midfielders' },
        { id: 4, plural_name: 'Forwards' },
      ],
      _metadata: {
        emergency_fallback: true,
        fallback_time: new Date().toISOString(),
      },
    };
  }

  /**
   * Get cache status
   */
  public getCacheStatus() {
    const cacheAgeMins = this.lastFallbackCache
      ? (Date.now() - this.fallbackCacheUpdateTime) / 1000 / 60
      : null;

    return {
      hasCachedData: !!this.lastFallbackCache,
      cacheAgeMins: cacheAgeMins ? parseFloat(cacheAgeMins.toFixed(2)) : null,
      cachePath: this.fallbackCachePath,
    };
  }
}
