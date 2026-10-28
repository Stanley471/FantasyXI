import {
  DocumentNode,
  OperationDefinitionNode,
  SelectionSetNode,
  FieldNode,
  FragmentDefinitionNode,
  InlineFragmentNode,
  visit,
  Kind,
} from "graphql";
import { getFieldWeight, getPaginationMultiplier, ComplexityConfig } from "../config/complexity.js";

/**
 * Result of analyzing a GraphQL query's complexity.
 */
export interface QueryComplexityResult {
  /** Total complexity score for the query */
  complexity: number;

  /** Maximum nesting depth of the query */
  depth: number;

  /** Number of fields in the query */
  fieldCount: number;

  /** Number of list fields in the query */
  listFieldCount: number;

  /** Breakdown of complexity by top-level field */
  breakdown: Map<string, number>;

  /** Whether the query complexity calculation was cached */
  cached: boolean;

  /** Time taken to calculate complexity in milliseconds */
  calculationTime: number;
}

/**
 * LRU cache for storing complexity calculations of query ASTs.
 * Uses document fingerprint (based on query structure) as key.
 */
class QueryComplexityCache {
  private cache: Map<string, QueryComplexityResult> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  /**
   * Get cached complexity result for a query.
   */
  get(key: string): QueryComplexityResult | undefined {
    const result = this.cache.get(key);
    if (result) {
      // Move to end for LRU
      this.cache.delete(key);
      this.cache.set(key, result);
    }
    return result;
  }

  /**
   * Store complexity result in cache.
   */
  set(key: string, result: QueryComplexityResult): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    if (this.cache.size >= this.maxSize) {
      // Remove oldest (first) entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, result);
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache size.
   */
  getSize(): number {
    return this.cache.size;
  }
}

// Global cache instance
const complexityCache = new QueryComplexityCache();

/**
 * Simple hash function for generating cache keys from GraphQL queries.
 * Not cryptographically secure, but good enough for caching.
 */
function hashQuery(document: DocumentNode): string {
  let hash = 0;
  const str = JSON.stringify(document);

  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  return Math.abs(hash).toString(36);
}

/**
 * Analyze a GraphQL query document and calculate its complexity score and depth.
 *
 * Complexity is calculated as:
 * - Each field has a base weight (0-10 typically)
 * - List fields are multiplied by pagination argument (first/last/limit)
 * - Nested fields contribute their complexity to parent
 *
 * @param document The parsed GraphQL document
 * @param config Complexity configuration
 * @param useCache Whether to use cached results
 * @returns QueryComplexityResult with complexity, depth, and breakdown
 */
export function analyzeQueryComplexity(
  document: DocumentNode,
  config: ComplexityConfig,
  useCache: boolean = true
): QueryComplexityResult {
  const startTime = performance.now();
  const cacheKey = useCache ? hashQuery(document) : "";

  // Check cache
  if (useCache && cacheKey) {
    const cached = complexityCache.get(cacheKey);
    if (cached) {
      return {
        ...cached,
        calculationTime: performance.now() - startTime,
      };
    }
  }

  // Find the operation (query, mutation, subscription)
  const operation = document.definitions.find(
    (def) => def.kind === Kind.OPERATION_DEFINITION
  ) as OperationDefinitionNode | undefined;

  if (!operation) {
    return {
      complexity: 0,
      depth: 0,
      fieldCount: 0,
      listFieldCount: 0,
      breakdown: new Map(),
      cached: false,
      calculationTime: performance.now() - startTime,
    };
  }

  // Build fragment definitions map for fragment lookups
  const fragmentMap = new Map<string, FragmentDefinitionNode>();
  document.definitions.forEach((def) => {
    if (def.kind === Kind.FRAGMENT_DEFINITION) {
      fragmentMap.set(def.name.value, def);
    }
  });

  // Analyze the selection set
  const { complexity, depth, fieldCount, listFieldCount, breakdown } = analyzeSelectionSet(
    operation.selectionSet,
    config,
    fragmentMap,
    0,
    ""
  );

  const result: QueryComplexityResult = {
    complexity,
    depth,
    fieldCount,
    listFieldCount,
    breakdown,
    cached: false,
    calculationTime: performance.now() - startTime,
  };

  // Cache the result
  if (useCache && cacheKey) {
    complexityCache.set(cacheKey, result);
  }

  return result;
}

/**
 * Recursively analyze a GraphQL selection set.
 */
interface AnalysisResult {
  complexity: number;
  depth: number;
  fieldCount: number;
  listFieldCount: number;
  breakdown: Map<string, number>;
}

function analyzeSelectionSet(
  selectionSet: SelectionSetNode | undefined,
  config: ComplexityConfig,
  fragmentMap: Map<string, FragmentDefinitionNode>,
  currentDepth: number,
  parentPath: string
): AnalysisResult {
  if (!selectionSet) {
    return {
      complexity: 0,
      depth: currentDepth,
      fieldCount: 0,
      listFieldCount: 0,
      breakdown: new Map(),
    };
  }

  let totalComplexity = 0;
  let maxDepth = currentDepth;
  let fieldCount = 0;
  let listFieldCount = 0;
  const breakdown = new Map<string, number>();

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const fieldNode = selection as FieldNode;
      const fieldName = fieldNode.name.value;
      const fieldPath = parentPath ? `${parentPath}.${fieldName}` : fieldName;
      const isListField = isFieldList(fieldPath);

      // Count pagination multiplier
      const paginationMultiplier = getPaginationMultiplier(
        convertArgumentsToRecord(fieldNode.arguments),
        config
      );

      // Get field weight
      const fieldWeight = getFieldWeight(parentPath || undefined, fieldName, isListField, config);

      // Calculate complexity for this field
      let fieldComplexity = fieldWeight * paginationMultiplier;

      // Recursively calculate child complexity
      if (fieldNode.selectionSet) {
        const childAnalysis = analyzeSelectionSet(
          fieldNode.selectionSet,
          config,
          fragmentMap,
          currentDepth + 1,
          fieldPath
        );

        // Child complexity is multiplied by pagination
        fieldComplexity += childAnalysis.complexity * paginationMultiplier;
        maxDepth = Math.max(maxDepth, childAnalysis.depth);
        fieldCount += childAnalysis.fieldCount;
        listFieldCount += childAnalysis.listFieldCount;

        // Merge breakdown
        for (const [key, value] of childAnalysis.breakdown) {
          breakdown.set(key, (breakdown.get(key) || 0) + value);
        }
      }

      totalComplexity += fieldComplexity;
      breakdown.set(fieldPath, (breakdown.get(fieldPath) || 0) + fieldComplexity);
      fieldCount++;

      if (isListField) {
        listFieldCount++;
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      // Handle inline fragments (e.g., ... on User { fields })
      const inlineFragment = selection as InlineFragmentNode;
      const fragmentAnalysis = analyzeSelectionSet(
        inlineFragment.selectionSet,
        config,
        fragmentMap,
        currentDepth,
        parentPath
      );

      totalComplexity += fragmentAnalysis.complexity;
      maxDepth = Math.max(maxDepth, fragmentAnalysis.depth);
      fieldCount += fragmentAnalysis.fieldCount;
      listFieldCount += fragmentAnalysis.listFieldCount;

      for (const [key, value] of fragmentAnalysis.breakdown) {
        breakdown.set(key, (breakdown.get(key) || 0) + value);
      }
    } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
      // Handle fragment spreads (e.g., ...UserFragment)
      const fragmentName = selection.name.value;
      const fragment = fragmentMap.get(fragmentName);

      if (fragment) {
        const fragmentAnalysis = analyzeSelectionSet(
          fragment.selectionSet,
          config,
          fragmentMap,
          currentDepth,
          parentPath
        );

        totalComplexity += fragmentAnalysis.complexity;
        maxDepth = Math.max(maxDepth, fragmentAnalysis.depth);
        fieldCount += fragmentAnalysis.fieldCount;
        listFieldCount += fragmentAnalysis.listFieldCount;

        for (const [key, value] of fragmentAnalysis.breakdown) {
          breakdown.set(key, (breakdown.get(key) || 0) + value);
        }
      }
    }
  }

  return {
    complexity: totalComplexity,
    depth: maxDepth,
    fieldCount,
    listFieldCount,
    breakdown,
  };
}

/**
 * Check if a field is a list field based on its path.
 * This is a heuristic based on common patterns in the schema.
 */
function isFieldList(fieldPath: string): boolean {
  // Fields that are known to return lists
  const listFields = [
    "users",
    "players",
    "leagues",
    "squads",
    "players", // SquadPlayer
    "members",
    "createdLeagues",
    "wallet",
  ];

  const fieldName = fieldPath.split(".").pop() || "";
  return listFields.includes(fieldName);
}

/**
 * Convert GraphQL arguments to a record for easier access.
 */
function convertArgumentsToRecord(
  args: readonly (import("graphql").ArgumentNode)[] | undefined
): Record<string, unknown> {
  if (!args) return {};

  const record: Record<string, unknown> = {};

  for (const arg of args) {
    const key = arg.name.value;
    const value = getArgumentValue(arg.value);
    record[key] = value;
  }

  return record;
}

/**
 * Extract the value from a GraphQL argument value node.
 */
function getArgumentValue(valueNode: any): unknown {
  switch (valueNode.kind) {
    case Kind.INT:
    case "IntValue":
      return parseInt(valueNode.value, 10);
    case Kind.FLOAT:
    case "FloatValue":
      return parseFloat(valueNode.value);
    case Kind.STRING:
    case "StringValue":
      return valueNode.value;
    case Kind.BOOLEAN:
    case "BooleanValue":
      return valueNode.value;
    case Kind.NULL:
    case "NullValue":
      return null;
    case Kind.LIST:
    case "ListValue":
      return valueNode.values.map(getArgumentValue);
    case Kind.OBJECT:
    case "ObjectValue":
      const obj: Record<string, unknown> = {};
      for (const objField of valueNode.fields) {
        obj[objField.name.value] = getArgumentValue(objField.value);
      }
      return obj;
    case Kind.VARIABLE:
      // Variables are evaluated at runtime, return placeholder
      return null;
    default:
      return null;
  }
}

/**
 * Calculate the maximum depth of a query.
 * Depth 0 = no selections, Depth 1 = root query fields, Depth 2 = nested selections, etc.
 */
export function calculateQueryDepth(
  document: DocumentNode,
  config: ComplexityConfig
): number {
  const operation = document.definitions.find(
    (def) => def.kind === Kind.OPERATION_DEFINITION
  ) as OperationDefinitionNode | undefined;

  if (!operation || !operation.selectionSet) {
    return 0;
  }

  return calculateSelectionSetDepth(operation.selectionSet);
}

/**
 * Recursively calculate the maximum depth of a selection set.
 */
function calculateSelectionSetDepth(selectionSet: SelectionSetNode): number {
  let maxDepth = 1;

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const fieldNode = selection as FieldNode;
      if (fieldNode.selectionSet) {
        const childDepth = calculateSelectionSetDepth(fieldNode.selectionSet);
        maxDepth = Math.max(maxDepth, 1 + childDepth);
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const inlineFragment = selection as InlineFragmentNode;
      if (inlineFragment.selectionSet) {
        const childDepth = calculateSelectionSetDepth(inlineFragment.selectionSet);
        maxDepth = Math.max(maxDepth, childDepth);
      }
    }
    // Fragment spreads are handled similarly but don't contribute to depth tracking in this context
  }

  return maxDepth;
}

/**
 * Get complexity cache statistics (for monitoring).
 */
export function getComplexityCacheStats(): {
  size: number;
  maxSize: number;
} {
  return {
    size: complexityCache.getSize(),
    maxSize: 1000,
  };
}

/**
 * Clear the complexity cache (useful for testing).
 */
export function clearComplexityCache(): void {
  complexityCache.clear();
}
