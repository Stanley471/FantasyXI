import axios from 'axios';
import { HealthCanary } from '../health-canary';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('Health Canary', () => {
  let canary: HealthCanary;

  beforeEach(() => {
    jest.clearAllMocks();
    // Create mock axios instance
    mockedAxios.create.mockReturnValue({
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      patch: jest.fn(),
      head: jest.fn(),
      options: jest.fn(),
      request: jest.fn(),
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
      },
    } as any);

    canary = new HealthCanary(
      'https://fantasy.premierleague.com/api',
      30000,
      3000,
      3000,
      3
    );
  });

  afterEach(() => {
    canary.stop();
  });

  describe('initialization', () => {
    it('should initialize with correct configuration', () => {
      expect(canary).toBeDefined();
      expect(canary.isPrimaryHealthy()).toBe(true);
    });

    it('should start with PRIMARY provider', () => {
      expect(canary.getCurrentProvider()).toBe('PRIMARY');
    });
  });

  describe('health probes', () => {
    it('should record successful probe', async () => {
      const mockResponse = {
        status: 200,
        data: {
          events: [{ id: 1, name: 'GW1', deadline_time: '2024-01-01' }],
          teams: [{ id: 1, name: 'Arsenal', code: 3, short_name: 'ARS' }],
          elements: [{ id: 1, first_name: 'John', second_name: 'Doe', element_type: 1, team: 1 }],
          element_types: [{ id: 1, plural_name: 'Goalkeepers' }],
        },
      };

      mockedAxios.create().get = jest.fn().mockResolvedValue(mockResponse);
      canary = new HealthCanary('https://fantasy.premierleague.com/api', 30000, 3000, 3000, 3);

      // Wait a bit for the canary to process
      await new Promise((resolve) => setTimeout(resolve, 100));

      const metrics = canary.getMetrics();
      expect(metrics.probesSucceeded).toBeGreaterThan(0);
    });

    it('should detect rate limiting (429)', async () => {
      const axiosError = new Error('429');
      (axiosError as any).response = { status: 429, data: {} };
      (axiosError as any).code = 'ERR_BAD_RESPONSE';

      mockedAxios.create().get = jest.fn().mockRejectedValue(axiosError);
      canary = new HealthCanary('https://fantasy.premierleague.com/api', 30000, 3000, 3000, 3);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const metrics = canary.getMetrics();
      expect(metrics.degradationIndicators.some((ind) => ind.type === 'RATE_LIMIT')).toBe(true);
    });

    it('should detect timeouts', async () => {
      const timeoutError = new Error('timeout of 3000ms exceeded');
      (timeoutError as any).code = 'ECONNABORTED';

      mockedAxios.create().get = jest.fn().mockRejectedValue(timeoutError);
      canary = new HealthCanary('https://fantasy.premierleague.com/api', 30000, 3000, 3000, 3);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const metrics = canary.getMetrics();
      expect(metrics.degradationIndicators.some((ind) => ind.type === 'TIMEOUT')).toBe(true);
    });
  });

  describe('circuit breaker integration', () => {
    it('should transition to OPEN on repeated failures', async () => {
      const error = new Error('Connection failed');

      mockedAxios.create().get = jest.fn().mockRejectedValue(error);
      canary = new HealthCanary('https://fantasy.premierleague.com/api', 100, 3000, 3000, 3);

      // Wait for multiple probes to fail
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(canary.getCircuitBreakerStatus().state).toBe('OPEN');
      expect(canary.isPrimaryHealthy()).toBe(false);
    });
  });

  describe('metrics', () => {
    it('should track probe counts', async () => {
      const mockResponse = {
        status: 200,
        data: {
          events: [{ id: 1, name: 'GW1', deadline_time: '2024-01-01' }],
          teams: [{ id: 1, name: 'Arsenal', code: 3, short_name: 'ARS' }],
          elements: [{ id: 1, first_name: 'John', second_name: 'Doe', element_type: 1, team: 1 }],
          element_types: [{ id: 1, plural_name: 'Goalkeepers' }],
        },
      };

      mockedAxios.create().get = jest.fn().mockResolvedValue(mockResponse);
      canary = new HealthCanary('https://fantasy.premierleague.com/api', 100, 3000, 3000, 3);

      await new Promise((resolve) => setTimeout(resolve, 350));

      const metrics = canary.getMetrics();
      expect(metrics.probesExecuted).toBeGreaterThan(0);
      expect(metrics.probesSucceeded).toBeGreaterThan(0);
      expect(metrics.probesFailed).toBe(0);
    });

    it('should calculate average response time', async () => {
      const mockResponse = {
        status: 200,
        data: {
          events: [{ id: 1, name: 'GW1', deadline_time: '2024-01-01' }],
          teams: [{ id: 1, name: 'Arsenal', code: 3, short_name: 'ARS' }],
          elements: [{ id: 1, first_name: 'John', second_name: 'Doe', element_type: 1, team: 1 }],
          element_types: [{ id: 1, plural_name: 'Goalkeepers' }],
        },
      };

      mockedAxios.create().get = jest.fn().mockResolvedValue(mockResponse);
      canary = new HealthCanary('https://fantasy.premierleague.com/api', 30000, 3000, 3000, 3);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const metrics = canary.getMetrics();
      expect(metrics.averageResponseTimeMs).toBeGreaterThan(0);
      expect(metrics.averageResponseTimeMs).toBeLessThan(3000);
    });
  });
});
