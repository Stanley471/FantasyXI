# GraphQL Query Complexity Limiter & Rate Governor

## Overview

The FantasyXI backend includes a comprehensive GraphQL query complexity and rate limiting system designed to prevent denial-of-service attacks through malicious or poorly constructed queries. The system analyzes query complexity before execution, enforces depth limits, and applies token-bucket rate limiting per user/IP.

## Architecture

### Components

1. **Complexity Configuration** (`src/config/complexity.ts`)
   - Central configuration management
   - Environment variable overrides
   - Field-specific complexity weights
   - Rate limit quotas

2. **Query Analyzer** (`src/graphql/queryAnalyzer.ts`)
   - AST-based complexity calculation
   - Field weight application
   - Pagination multiplier handling
   - LRU caching of complexity calculations

3. **Depth Validator** (`src/graphql/depthValidator.ts`)
   - Maximum nesting depth enforcement
   - Early-exit optimization
   - Detailed error reporting

4. **Rate Governor** (`src/graphql/complexityRateGovernor.ts`)
   - Redis-backed token bucket implementation
   - Distributed rate limiting
   - In-memory fallback when Redis unavailable
   - Per-user and per-IP tracking

5. **Apollo Server Plugin** (`src/graphql/complexityPlugin.ts`)
   - Integrates all components via Apollo plugins
   - Validates queries before execution
   - Attaches complexity metadata to context
   - Handles error responses

## Configuration

### Environment Variables

All configuration uses environment variables with sensible defaults. Set in `.env` or `.env.local`:

```bash
# Enable/disable complexity checking entirely
GQL_COMPLEXITY_ENABLED=true

# Maximum query nesting depth (default: 10)
GQL_MAX_DEPTH=10

# Maximum complexity score per query (default: 5000)
GQL_MAX_COMPLEXITY=5000

# Base complexity for scalar fields (default: 1)
GQL_DEFAULT_FIELD_WEIGHT=1

# Complexity multiplier for list fields (default: 5)
GQL_LIST_FIELD_WEIGHT=5

# Complexity multiplier for object fields (default: 2)
GQL_OBJECT_FIELD_WEIGHT=2

# Default pagination multiplier when limit not specified (default: 1)
GQL_DEFAULT_PAGINATION_MULTIPLIER=1

# Maximum pagination multiplier (cap on first/last/limit args) (default: 1000)
GQL_MAX_PAGINATION_MULTIPLIER=1000

# Per-user rate limit: max complexity points per minute (default: 10000)
GQL_COMPLEXITY_RATE_LIMIT=10000

# Per-IP rate limit: max complexity points per minute (default: 50000)
GQL_IP_RATE_LIMIT=50000

# Burst allowance multiplier (e.g., 1.5 = 150% of rate limit) (default: 1.5)
GQL_BURST_MULTIPLIER=1.5

# Max time (ms) allowed for complexity calculation (default: 50)
GQL_COMPLEXITY_CALCULATION_TIMEOUT_MS=50

# Enable detailed logging for debugging (default: false)
GQL_COMPLEXITY_DEBUG=false

# Use Redis for distributed rate limiting (default: true)
GQL_COMPLEXITY_USE_REDIS=true

# TTL in seconds for complexity rate limit tokens in Redis (default: 60)
GQL_COMPLEXITY_REDIS_TTL=60

# Enable caching of AST complexity calculations (default: true)
GQL_COMPLEXITY_ENABLE_AST_CACHE=true

# Maximum number of cached AST analyses (default: 1000)
GQL_COMPLEXITY_AST_CACHE_SIZE=1000
```

### Field-Specific Weights

Override complexity weights for specific fields using environment variables:

```bash
# Format: GQL_FIELD_WEIGHT_<TYPENAME_FIELDNAME>=<weight>
GQL_FIELD_WEIGHT_QUERY_USERS=3
GQL_FIELD_WEIGHT_QUERY_LEAGUES=4
GQL_FIELD_WEIGHT_USER_SQUADS=8
GQL_FIELD_WEIGHT_LEAGUE_MEMBERS=10
```

### Default Field Weights (FantasyXI Schema)

```
Query Fields:
  Query.users = 3           # High cost: loads multiple users
  Query.user = 1            # Low cost: single user lookup
  Query.players = 3         # High cost: loads multiple players
  Query.player = 1          # Low cost: single player lookup
  Query.leagues = 4         # High cost: complex league data
  Query.league = 2          # Medium cost: league details

User Fields:
  User.wallet = 1
  User.squads = 5           # High cost: loads squads
  User.createdLeagues = 5   # High cost: loads leagues

Squad Fields:
  Squad.players = 8         # Very high cost: loads all squad players

League Fields:
  League.members = 10       # Very high cost: loads all members
  League.creator = 2

Player Fields:
  Player.team = 2
```

## How It Works

### Complexity Scoring Formula

```
complexityScore = baseFieldCost + (childComplexity × paginationMultiplier)
```

Where:
- `baseFieldCost`: Configured weight per field (typically 1-10)
- `childComplexity`: Sum of all nested field costs
- `paginationMultiplier`: Value from `first`/`last`/`limit` arguments (capped at `maxPaginationMultiplier`)

### Example Calculation

```graphql
query {
  users(limit: 100) {           # Cost: 3 * 100 = 300
    id                           # Cost: 0 (scalar)
    squads {                     # Cost: 5 * 100 = 500
      id                         # Cost: 0
      players {                  # Cost: 8 * 1 = 8 (no pagination)
        id                       # Cost: 0
      }
    }
  }
}
```

Total Complexity:
- Users query: 3 * 100 = 300
- Squads (per user): 5 * 100 = 500 per user
- Players per squad: 8
- Total: 300 + (500 * 8) = 4,300

### Depth Calculation

Depth is the maximum nesting level of field selections:
- Depth 1: Root query fields (e.g., `query { users { ... } }`)
- Depth 2: Nested selections (e.g., `{ users { squads { ... } } }`)
- Depth 3+: Further nesting

Default max depth: **10 levels**

### Rate Limiting Strategy

Uses token bucket algorithm:
1. Each user/IP gets a token bucket that refills over time
2. Tokens = complexity score (not requests)
3. Each query consumes tokens equal to its complexity
4. Refill rate: `complexityRateLimitPerMinute` tokens per minute
5. Burst allowance: `burstMultiplier × rateLimitPerMinute`

Example:
- User rate limit: 10,000 complexity/minute
- Query complexity: 500
- User can run 20 such queries/minute
- With burst: can accumulate up to 15,000 tokens

## Validation Flow

When a GraphQL query is executed:

1. **Parse & Validate**
   - GraphQL parser creates AST
   - Plugin receives `didResolveOperation` hook

2. **Depth Check**
   - Traverse AST and calculate maximum depth
   - If depth > `maxDepth`: reject with 400 Bad Request
   - Early exit optimization stops at violation

3. **Complexity Calculation**
   - Analyze query structure and calculate complexity
   - Apply field weights and pagination multipliers
   - Cache result for identical queries
   - If calculation > `calculationTimeoutMs`: reject

4. **Complexity Limit Check**
   - If complexity > `maxComplexityPerQuery`: reject with 400

5. **Rate Limit Check**
   - Identify user (by userId or IP)
   - Check token bucket
   - If insufficient tokens: reject with 429 (Too Many Requests)
   - Include `Retry-After` header

6. **Success**
   - Attach complexity metadata to context
   - Query proceeds to execution
   - Metadata available in resolvers

## Error Responses

### Depth Exceeded

```json
{
  "errors": [
    {
      "message": "Query depth exceeds maximum allowed (max: 10, actual: 12). Deepest field path: users.squads.players.player.team",
      "extensions": {
        "code": "QUERY_DEPTH_EXCEEDED",
        "maxDepth": 10,
        "actualDepth": 12,
        "deepestPath": "users.squads.players.player.team"
      }
    }
  ]
}
```

### Complexity Exceeded

```json
{
  "errors": [
    {
      "message": "Query complexity exceeds maximum allowed (max: 5000, actual: 8500)",
      "extensions": {
        "code": "QUERY_COMPLEXITY_EXCEEDED",
        "maxComplexity": 5000,
        "actualComplexity": 8500
      }
    }
  ]
}
```

### Rate Limited

```json
{
  "errors": [
    {
      "message": "Query complexity rate limit exceeded. Needed: 2000, Available: 1500. Retry after 30.0 seconds.",
      "extensions": {
        "code": "COMPLEXITY_RATE_LIMIT_EXCEEDED",
        "needed": 2000,
        "available": 1500,
        "retryAfter": 30.0
      }
    }
  ]
}
```

HTTP Status: `429 Too Many Requests`
Header: `Retry-After: 30`

## Accessing Complexity Metadata

Resolvers can access complexity information from context:

```typescript
import { getComplexityMetadata } from "../graphql/complexityPlugin.js";

export const resolvers = {
  Query: {
    users: async (_parent, args, context) => {
      const metadata = getComplexityMetadata(context);
      
      if (metadata) {
        console.log(`Query complexity: ${metadata.complexity}`);
        console.log(`Validation time: ${metadata.validationTime}ms`);
        console.log(`Rate limit info:`, metadata.rateLimitInfo);
      }
      
      // ... resolver logic
    }
  }
};
```

Metadata structure:
```typescript
interface ComplexityMetadata {
  complexity: number;           // Query complexity score
  depth: number;                // Maximum nesting depth
  fieldCount: number;           // Total fields selected
  depthValid: boolean;          // Passed depth validation
  rateLimitPassed: boolean;     // Passed rate limiting
  rateLimitInfo?: {
    tokens: number;             // Remaining tokens
    maxTokens: number;          // Bucket capacity
    retryAfter?: number;        // Seconds until retry
  };
  validationTime: number;       // Validation time in ms
}
```

## Performance Characteristics

- **Complexity calculation**: <2ms typical (< 50ms max timeout)
- **Depth validation**: <1ms (early exit optimization)
- **Rate limit check**: <1ms (Redis or in-memory)
- **Total overhead**: <5ms for typical queries

### Caching

- Query complexity calculated once per unique query structure
- LRU cache with configurable size (default: 1,000 entries)
- Cache automatically evicts oldest entry when full

## Testing

### Run All Tests

```bash
npm run test -- src/graphql/__tests__
```

### Run Specific Test Suites

```bash
# Complexity calculator tests
npm run test -- src/graphql/__tests__/queryAnalyzer.test.ts

# Depth validator tests
npm run test -- src/graphql/__tests__/depthValidator.test.ts

# Apollo plugin integration tests
npm run test -- src/graphql/__tests__/complexityPlugin.test.ts

# Security/attack pattern tests
npm run test -- src/graphql/__tests__/complexitySecurity.test.ts
```

### Test Coverage

The implementation includes:
- **Unit tests**: 50+ test cases for calculator and validator
- **Integration tests**: 20+ test cases for Apollo plugin
- **Security tests**: 30+ test cases for malicious query patterns

## Deployment Recommendations

### Development

```bash
GQL_COMPLEXITY_ENABLED=true
GQL_MAX_DEPTH=15              # More permissive
GQL_MAX_COMPLEXITY=10000      # Higher limit
GQL_COMPLEXITY_DEBUG=true     # Debug logging
```

### Staging

```bash
GQL_COMPLEXITY_ENABLED=true
GQL_MAX_DEPTH=12
GQL_MAX_COMPLEXITY=8000
GQL_COMPLEXITY_RATE_LIMIT=5000
```

### Production

```bash
GQL_COMPLEXITY_ENABLED=true
GQL_MAX_DEPTH=10              # Strict
GQL_MAX_COMPLEXITY=5000       # Strict
GQL_COMPLEXITY_RATE_LIMIT=10000
GQL_IP_RATE_LIMIT=50000
GQL_BURST_MULTIPLIER=1.2      # Lower burst allowance
GQL_COMPLEXITY_DEBUG=false    # No debug logging
```

## Monitoring & Observability

### Metrics to Track

1. **Complexity Distribution**
   - Average query complexity
   - P95/P99 complexity percentiles
   - Queries rejected due to complexity

2. **Rate Limit Events**
   - Number of rate-limited requests
   - Average tokens remaining
   - Burst usage patterns

3. **Depth Violations**
   - Queries rejected due to depth
   - Most common violating field paths

4. **Performance**
   - Complexity calculation time
   - Plugin execution overhead
   - Cache hit ratio

### Debug Logging

Enable with `GQL_COMPLEXITY_DEBUG=true` to see:

```
[Complexity] Query accepted: complexity=500, depth=3, fields=15, validationTime=1.23ms
[Complexity] Depth validation failed for getUserProfile: users.squads.players
[Complexity] Query complexity exceeded for listLeagues: 6000/5000
[Complexity] Rate limit exceeded for user user-123: needed 2000, have 500
```

## Troubleshooting

### Query Rejected Unexpectedly

1. Check complexity: `GQL_COMPLEXITY_DEBUG=true` to see calculated score
2. Review field weights: Are lists weighted appropriately?
3. Check pagination args: Large `limit` values multiply complexity
4. Verify depth: Count nesting levels in query

### Rate Limiting Too Strict

1. Increase `GQL_COMPLEXITY_RATE_LIMIT`
2. Increase `GQL_BURST_MULTIPLIER`
3. Reduce field weights for common queries
4. Check if users need higher quotas

### Performance Impact

1. Verify calculation time < 50ms: `GQL_COMPLEXITY_DEBUG=true`
2. Check cache hit ratio: Monitor query patterns
3. Reduce `GQL_COMPLEXITY_AST_CACHE_SIZE` if memory-constrained
4. Consider disabling complexity checking for internal APIs

### Redis Connection Issues

- System automatically falls back to in-memory rate limiting
- Check Redis connectivity: `redis-cli ping`
- Monitor Redis usage: `redis-cli info stats`
- Increase `GQL_COMPLEXITY_REDIS_TTL` for longer-lived buckets

## Security Considerations

### Attacks Prevented

1. **Deep Nesting DoS**: Rejects queries deeper than `maxDepth`
2. **Large Pagination**: Caps pagination multiplier at `maxPaginationMultiplier`
3. **Alias Expansion**: Counts all aliases as separate fields
4. **GraphQL Bomb**: Multiplies nested list costs correctly
5. **CPU Exhaustion**: Timeout on calculation
6. **Rate Attacks**: Token bucket prevents rapid fire requests

### Limitations

- Does not validate query results (only structure)
- Does not prevent slow databases from slowing overall response
- Does not account for resolver caching efficiency
- Assumes field costs are static (not computed per request)

## Advanced Configuration

### Custom Field Weights by Environment

```bash
# Production: stricter weights
export GQL_FIELD_WEIGHT_QUERY_LEAGUES=6
export GQL_FIELD_WEIGHT_LEAGUE_MEMBERS=15

# Development: more permissive
export GQL_FIELD_WEIGHT_QUERY_LEAGUES=3
export GQL_FIELD_WEIGHT_LEAGUE_MEMBERS=5
```

### Dynamic Rate Limits (Future Enhancement)

Currently, rate limits are static per environment. Future versions could support:
- Per-user custom limits
- Time-of-day rate limiting
- Premium tier higher quotas
- Temporary suspension for abusers

### Query Allowlisting (Future Enhancement)

Could implement query allowlist for:
- Pre-analyzed trusted queries
- Mobile app fixed queries
- Cost-free internal operations

## References

- [GraphQL Complexity Analysis](https://cheatsheetseries.owasp.org/cheatsheets/Query_Complexity_Analysis_Cheat_Sheet.html)
- [Apollo Server Plugins](https://www.apollographql.com/docs/apollo-server/plugins/)
- [Token Bucket Algorithm](https://en.wikipedia.org/wiki/Token_bucket)
- [GraphQL Security Best Practices](https://owasp.org/www-community/attacks/GraphQL)

## Support

For issues or questions:
1. Check debug logs: `GQL_COMPLEXITY_DEBUG=true`
2. Review test cases for examples
3. Examine field weights configuration
4. Contact the backend team

## Version History

- **v1.0.0** (Initial): Core complexity limiter with depth validation and rate limiting
  - AST-based complexity calculation
  - Token bucket rate limiting
  - Redis-backed distributed tracking
  - Apollo Server plugin integration
