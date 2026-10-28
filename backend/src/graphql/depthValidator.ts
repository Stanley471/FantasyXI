import {
  DocumentNode,
  OperationDefinitionNode,
  SelectionSetNode,
  FieldNode,
  InlineFragmentNode,
  Kind,
  GraphQLError,
} from "graphql";
import { ComplexityConfig } from "../config/complexity.js";

/**
 * Errors that can occur during depth validation.
 */
export class QueryDepthExceededError extends GraphQLError {
  constructor(maxDepth: number, actualDepth: number, deepestPath: string) {
    super(
      `Query depth exceeds maximum allowed (max: ${maxDepth}, actual: ${actualDepth}). ` +
        `Deepest field path: ${deepestPath}`,
      {
        extensions: {
          code: "QUERY_DEPTH_EXCEEDED",
          maxDepth,
          actualDepth,
          deepestPath,
        },
      }
    );
    this.name = "QueryDepthExceededError";
  }
}

/**
 * Validation result from depth validation.
 */
export interface DepthValidationResult {
  /** Whether the query passes depth validation */
  valid: boolean;

  /** Actual depth of the query */
  depth: number;

  /** Maximum allowed depth */
  maxDepth: number;

  /** Path to the deepest field in the query */
  deepestPath: string;

  /** Error if validation failed */
  error?: GraphQLError;

  /** Time taken to validate in milliseconds */
  validationTime: number;
}

/**
 * Validate that a GraphQL query does not exceed maximum depth.
 *
 * Depth is defined as the maximum nesting level of field selections:
 * - Depth 0: Empty selection set
 * - Depth 1: Root query fields (e.g., `query { users { ... } }`)
 * - Depth 2: Nested field selections (e.g., `{ users { squads { ... } } }`)
 * etc.
 *
 * @param document The parsed GraphQL document
 * @param config Complexity configuration
 * @returns DepthValidationResult
 */
export function validateQueryDepth(
  document: DocumentNode,
  config: ComplexityConfig
): DepthValidationResult {
  const startTime = performance.now();

  // Find the operation
  const operation = document.definitions.find(
    (def) => def.kind === Kind.OPERATION_DEFINITION
  ) as OperationDefinitionNode | undefined;

  if (!operation) {
    return {
      valid: true,
      depth: 0,
      maxDepth: config.maxDepth,
      deepestPath: "",
      validationTime: performance.now() - startTime,
    };
  }

  // Validate the selection set
  const { depth, path } = validateSelectionSetDepth(
    operation.selectionSet,
    config.maxDepth,
    0,
    ""
  );

  const validationTime = performance.now() - startTime;

  if (depth > config.maxDepth) {
    return {
      valid: false,
      depth,
      maxDepth: config.maxDepth,
      deepestPath: path,
      error: new QueryDepthExceededError(config.maxDepth, depth, path),
      validationTime,
    };
  }

  return {
    valid: true,
    depth,
    maxDepth: config.maxDepth,
    deepestPath: path,
    validationTime,
  };
}

/**
 * Result of validating a selection set depth.
 */
interface SelectionSetDepthResult {
  /** Maximum depth found in this selection set */
  depth: number;

  /** Path to the deepest field */
  path: string;
}

/**
 * Recursively validate a selection set and calculate its depth.
 * Throws early if maximum depth is exceeded (short-circuit optimization).
 */
function validateSelectionSetDepth(
  selectionSet: SelectionSetNode | undefined,
  maxDepth: number,
  currentDepth: number,
  currentPath: string
): SelectionSetDepthResult {
  if (!selectionSet) {
    return {
      depth: currentDepth,
      path: currentPath,
    };
  }

  let maxDepthFound = currentDepth;
  let deepestPath = currentPath;

  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const fieldNode = selection as FieldNode;
      const fieldName = fieldNode.name.value;
      const fieldPath = currentPath ? `${currentPath}.${fieldName}` : fieldName;

      if (fieldNode.selectionSet) {
        const nextDepth = currentDepth + 1;

        // Early exit if we already exceed max depth
        if (nextDepth > maxDepth) {
          return {
            depth: nextDepth,
            path: fieldPath,
          };
        }

        const childResult = validateSelectionSetDepth(
          fieldNode.selectionSet,
          maxDepth,
          nextDepth,
          fieldPath
        );

        if (childResult.depth > maxDepthFound) {
          maxDepthFound = childResult.depth;
          deepestPath = childResult.path;
        }

        // Early exit if child exceeded max depth
        if (childResult.depth > maxDepth) {
          return childResult;
        }
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      const inlineFragment = selection as InlineFragmentNode;
      const childResult = validateSelectionSetDepth(
        inlineFragment.selectionSet,
        maxDepth,
        currentDepth,
        currentPath
      );

      if (childResult.depth > maxDepthFound) {
        maxDepthFound = childResult.depth;
        deepestPath = childResult.path;
      }

      // Early exit if child exceeded max depth
      if (childResult.depth > maxDepth) {
        return childResult;
      }
    }
    // Fragment spreads: In a production system, you would resolve these,
    // but for now we skip them as they're not used in the FantasyXI schema
  }

  return {
    depth: maxDepthFound,
    path: deepestPath,
  };
}

/**
 * Create a depth validator function that can be used as Apollo Server middleware.
 *
 * @param config Complexity configuration
 * @returns A validation function
 */
export function createDepthValidator(config: ComplexityConfig) {
  return function validateDepth(document: DocumentNode): DepthValidationResult {
    return validateQueryDepth(document, config);
  };
}

/**
 * Format a depth validation result for logging or debugging.
 */
export function formatDepthValidationResult(result: DepthValidationResult): string {
  if (result.valid) {
    return `✓ Query depth valid (depth: ${result.depth}, max: ${result.maxDepth})`;
  } else {
    return (
      `✗ Query depth exceeded (depth: ${result.depth}, max: ${result.maxDepth}). ` +
      `Deepest path: ${result.deepestPath}`
    );
  }
}

/**
 * Extract the deepest field names from a path string.
 * Useful for understanding which fields contributed to high depth.
 */
export function extractDeepFieldNames(path: string): string[] {
  return path.split(".").filter((s) => s.length > 0);
}

/**
 * Check if a query uses any fields that are known to have high depth potential.
 * Useful for additional risk assessment.
 */
export function hasRiskyFields(
  deepFields: string[]
): { risky: boolean; fields: string[] } {
  const riskyFields = ["squads", "members", "createdLeagues", "users", "leagues", "players"];
  const found = deepFields.filter((field) => riskyFields.includes(field));

  return {
    risky: found.length > 0,
    fields: found,
  };
}
