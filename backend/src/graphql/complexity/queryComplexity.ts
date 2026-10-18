import {
  DocumentNode,
  FieldNode,
  FragmentDefinitionNode,
  GraphQLField,
  GraphQLNamedType,
  GraphQLSchema,
  GraphQLType,
  Kind,
  OperationDefinitionNode,
  OperationTypeNode,
  SelectionSetNode,
  ValueNode,
  getNamedType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
} from "graphql";

/**
 * GraphQL Query Complexity and Depth Analysis (issue #265).
 *
 * A single AST walk computes both the maximum selection depth and an
 * estimated execution cost for an operation, before any resolver runs:
 *
 *   cost(field) = weight(field) + listMultiplier(field) * cost(children)
 *
 * - `weight` defaults to 1 for object/list fields and 0 for leaf (scalar /
 *   enum) fields, and can be overridden per `Type.field`.
 * - `listMultiplier` is 1 for non-list fields. For list fields it is read from
 *   a pagination argument (`first`, `last`, `limit`, `take`, `pageSize`) -
 *   literal, variable, or the schema's declared default - and clamped to
 *   `maxListSize`. Unbounded lists with no such argument use `defaultListSize`.
 * - Fragment spreads are expanded in place. A cyclic spread (which validation
 *   normally rejects, but subscriptions may be analysed before validation) is
 *   counted once and not re-entered, so analysis always terminates.
 * - `@skip(if: true)` / `@include(if: false)` selections cost nothing.
 * - Introspection fields (`__schema`, `__type`, `__typename`) are excluded by
 *   default so tooling introspection is not rejected by the depth limit.
 *
 * Selections on abstract types are summed across all inline fragments, a
 * deliberate over-estimate: a cheap upper bound is safer than an exact count.
 */

export interface QueryComplexityConfig {
  /** Reject operations whose selection depth exceeds this. */
  maxDepth: number;
  /** Reject operations whose estimated cost exceeds this. */
  maxComplexity: number;
  /** Multiplier for list fields without a pagination argument or default. */
  defaultListSize: number;
  /** Upper bound applied to any pagination argument. */
  maxListSize: number;
  /** Cost of a field returning an object or list. */
  objectFieldCost: number;
  /** Cost of a field returning a scalar or enum. */
  scalarFieldCost: number;
  /** Per-field weight overrides, keyed by `TypeName.fieldName`. */
  fieldWeights: Record<string, number>;
  /** Exclude `__schema` / `__type` / `__typename` from depth and cost. */
  ignoreIntrospection: boolean;
}

export const PAGINATION_ARGUMENTS = ["first", "last", "limit", "take", "pageSize"] as const;

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getQueryComplexityConfig(
  overrides: Partial<QueryComplexityConfig> = {}
): QueryComplexityConfig {
  return {
    maxDepth: envInt("GRAPHQL_MAX_DEPTH", 8),
    maxComplexity: envInt("GRAPHQL_MAX_COMPLEXITY", 3000),
    defaultListSize: envInt("GRAPHQL_DEFAULT_LIST_SIZE", 10),
    maxListSize: envInt("GRAPHQL_MAX_LIST_SIZE", 100),
    objectFieldCost: 1,
    scalarFieldCost: 0,
    fieldWeights: {},
    ignoreIntrospection: true,
    ...overrides,
  };
}

export type ComplexityViolation =
  | { code: "QUERY_TOO_DEEP"; limit: number; actual: number }
  | { code: "QUERY_TOO_COMPLEX"; limit: number; actual: number };

export interface QueryComplexityResult {
  operationType: OperationTypeNode;
  operationName: string | null;
  depth: number;
  complexity: number;
  violations: ComplexityViolation[];
}

export class OperationNotFoundError extends Error {
  constructor(operationName?: string | null) {
    super(
      operationName
        ? `Operation "${operationName}" was not found in the document`
        : "Document must contain exactly one operation when no operationName is given"
    );
    this.name = "OperationNotFoundError";
  }
}

export interface AnalyzeOperationInput {
  schema: GraphQLSchema;
  document: DocumentNode;
  operationName?: string | null;
  variables?: Record<string, unknown> | null;
  config?: QueryComplexityConfig;
}

export function selectOperation(
  document: DocumentNode,
  operationName?: string | null
): OperationDefinitionNode {
  const operations = document.definitions.filter(
    (def): def is OperationDefinitionNode => def.kind === Kind.OPERATION_DEFINITION
  );
  const operation = operationName
    ? operations.find((op) => op.name?.value === operationName)
    : operations.length === 1
      ? operations[0]
      : undefined;
  if (!operation) {
    throw new OperationNotFoundError(operationName);
  }
  return operation;
}

class ComplexityWalker {
  private readonly fragments = new Map<string, FragmentDefinitionNode>();
  private readonly activeFragments = new Set<string>();
  private readonly variables: Record<string, unknown>;
  public maxDepth = 0;

  constructor(
    private readonly schema: GraphQLSchema,
    document: DocumentNode,
    operation: OperationDefinitionNode,
    variables: Record<string, unknown>,
    private readonly config: QueryComplexityConfig
  ) {
    for (const def of document.definitions) {
      if (def.kind === Kind.FRAGMENT_DEFINITION) {
        this.fragments.set(def.name.value, def);
      }
    }
    // Apply operation-level variable defaults underneath supplied values
    const resolved: Record<string, unknown> = {};
    for (const varDef of operation.variableDefinitions ?? []) {
      if (varDef.defaultValue) {
        resolved[varDef.variable.name.value] = this.literalValue(varDef.defaultValue, {});
      }
    }
    this.variables = { ...resolved, ...variables };
  }

  private literalValue(node: ValueNode, vars: Record<string, unknown>): unknown {
    switch (node.kind) {
      case Kind.VARIABLE:
        return vars[node.name.value];
      case Kind.INT:
      case Kind.FLOAT:
        return Number(node.value);
      case Kind.BOOLEAN:
        return node.value;
      case Kind.STRING:
      case Kind.ENUM:
        return node.value;
      case Kind.NULL:
        return null;
      case Kind.LIST:
        return node.values.map((v) => this.literalValue(v, vars));
      case Kind.OBJECT:
        return Object.fromEntries(
          node.fields.map((f) => [f.name.value, this.literalValue(f.value, vars)])
        );
    }
  }

  private isExcludedByDirective(node: { directives?: readonly { name: { value: string }; arguments?: readonly { name: { value: string }; value: ValueNode }[] }[] }): boolean {
    for (const directive of node.directives ?? []) {
      const name = directive.name.value;
      if (name !== "skip" && name !== "include") continue;
      const ifArg = directive.arguments?.find((a) => a.name.value === "if");
      if (!ifArg) continue;
      const condition = this.literalValue(ifArg.value, this.variables) === true;
      if (name === "skip" && condition) return true;
      if (name === "include" && !condition) return true;
    }
    return false;
  }

  private listMultiplier(
    fieldNode: FieldNode,
    fieldDef: GraphQLField<unknown, unknown>
  ): number {
    let type: GraphQLType = fieldDef.type;
    if (isNonNullType(type)) type = type.ofType;
    if (!isListType(type)) return 1;

    for (const argName of PAGINATION_ARGUMENTS) {
      const argNode = fieldNode.arguments?.find((a) => a.name.value === argName);
      let value: unknown = argNode ? this.literalValue(argNode.value, this.variables) : undefined;
      if (value === undefined || value === null) {
        value = fieldDef.args.find((a) => a.name === argName)?.defaultValue;
      }
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.min(Math.max(Math.floor(value), 0), this.config.maxListSize);
      }
    }
    return Math.min(this.config.defaultListSize, this.config.maxListSize);
  }

  private fieldDefinition(
    parentType: GraphQLNamedType,
    fieldName: string
  ): GraphQLField<unknown, unknown> | undefined {
    if (isObjectType(parentType) || isInterfaceType(parentType)) {
      return parentType.getFields()[fieldName];
    }
    return undefined;
  }

  public selectionSetCost(
    selectionSet: SelectionSetNode,
    parentType: GraphQLNamedType,
    depth: number
  ): number {
    let cost = 0;

    for (const selection of selectionSet.selections) {
      if (this.isExcludedByDirective(selection)) continue;

      if (selection.kind === Kind.FIELD) {
        const fieldName = selection.name.value;
        if (fieldName.startsWith("__") && this.config.ignoreIntrospection) continue;

        const fieldDepth = depth + 1;
        if (fieldDepth > this.maxDepth) this.maxDepth = fieldDepth;

        const fieldDef = this.fieldDefinition(parentType, fieldName);
        if (!fieldDef) continue; // Unknown fields are rejected by validation

        const namedType = getNamedType(fieldDef.type);
        const weightKey = `${parentType.name}.${fieldName}`;
        const isLeaf = !selection.selectionSet;
        const weight =
          this.config.fieldWeights[weightKey] ??
          (isLeaf ? this.config.scalarFieldCost : this.config.objectFieldCost);

        if (isLeaf) {
          cost += weight;
          continue;
        }

        const childCost = this.selectionSetCost(selection.selectionSet!, namedType, fieldDepth);
        cost += weight + this.listMultiplier(selection, fieldDef) * childCost;
        continue;
      }

      if (selection.kind === Kind.INLINE_FRAGMENT) {
        const typeCondition = selection.typeCondition
          ? this.schema.getType(selection.typeCondition.name.value)
          : parentType;
        cost += this.selectionSetCost(selection.selectionSet, typeCondition ?? parentType, depth);
        continue;
      }

      // FRAGMENT_SPREAD
      const name = selection.name.value;
      const fragment = this.fragments.get(name);
      if (!fragment || this.activeFragments.has(name)) continue;
      this.activeFragments.add(name);
      const typeCondition = this.schema.getType(fragment.typeCondition.name.value);
      cost += this.selectionSetCost(fragment.selectionSet, typeCondition ?? parentType, depth);
      this.activeFragments.delete(name);
    }

    return cost;
  }
}

/**
 * Computes depth and complexity for one operation in `document` and lists any
 * configured limits it breaks. Pure and synchronous: no resolver runs.
 */
export function analyzeOperation(input: AnalyzeOperationInput): QueryComplexityResult {
  const config = input.config ?? getQueryComplexityConfig();
  const operation = selectOperation(input.document, input.operationName);
  const rootType =
    operation.operation === OperationTypeNode.QUERY
      ? input.schema.getQueryType()
      : operation.operation === OperationTypeNode.MUTATION
        ? input.schema.getMutationType()
        : input.schema.getSubscriptionType();

  let depth = 0;
  let complexity = 0;
  if (rootType) {
    const walker = new ComplexityWalker(
      input.schema,
      input.document,
      operation,
      input.variables ?? {},
      config
    );
    complexity = walker.selectionSetCost(operation.selectionSet, rootType, 0);
    depth = walker.maxDepth;
  }

  const violations: ComplexityViolation[] = [];
  if (depth > config.maxDepth) {
    violations.push({ code: "QUERY_TOO_DEEP", limit: config.maxDepth, actual: depth });
  }
  if (complexity > config.maxComplexity) {
    violations.push({ code: "QUERY_TOO_COMPLEX", limit: config.maxComplexity, actual: complexity });
  }

  return {
    operationType: operation.operation,
    operationName: operation.name?.value ?? null,
    depth,
    complexity,
    violations,
  };
}
