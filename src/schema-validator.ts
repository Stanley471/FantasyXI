import { logger } from './logger';
import { SchemaValidationResult } from './types';

/**
 * Define expected FPL API schema
 * This represents the critical fields that must be present in bootstrap-static endpoint
 */
const FPL_BOOTSTRAP_SCHEMA = {
  events: {
    type: 'array',
    requiredFields: ['id', 'name', 'deadline_time'],
  },
  teams: {
    type: 'array',
    requiredFields: ['id', 'name', 'code', 'short_name'],
  },
  elements: {
    type: 'array',
    requiredFields: ['id', 'first_name', 'second_name', 'element_type', 'team'],
  },
  element_types: {
    type: 'array',
    requiredFields: ['id', 'plural_name'],
  },
};

/**
 * Validate FPL API response against expected schema
 */
export function validateFPLSchema(data: unknown): SchemaValidationResult {
  if (!data || typeof data !== 'object') {
    return {
      isValid: false,
      typeErrors: { root: 'Response is not a valid object' },
    };
  }

  const dataObj = data as Record<string, unknown>;
  const missingFields: string[] = [];
  const typeErrors: Record<string, string> = {};

  // Check for required top-level fields
  for (const [field, schema] of Object.entries(FPL_BOOTSTRAP_SCHEMA)) {
    if (!(field in dataObj)) {
      missingFields.push(field);
      continue;
    }

    const fieldValue = dataObj[field];

    // Validate array type
    if (schema.type === 'array') {
      if (!Array.isArray(fieldValue)) {
        typeErrors[field] = `Expected array, got ${typeof fieldValue}`;
        continue;
      }

      // Validate required fields in array items
      if (fieldValue.length > 0) {
        const firstItem = fieldValue[0] as Record<string, unknown>;
        for (const requiredField of schema.requiredFields) {
          if (!(requiredField in firstItem)) {
            typeErrors[`${field}.${requiredField}`] = `Missing required field "${requiredField}" in array items`;
            break;
          }
        }
      }
    }
  }

  const isValid = missingFields.length === 0 && Object.keys(typeErrors).length === 0;

  return {
    isValid,
    missingFields: missingFields.length > 0 ? missingFields : undefined,
    typeErrors: Object.keys(typeErrors).length > 0 ? typeErrors : undefined,
  };
}

/**
 * Check if schema validation failure indicates a significant change
 */
export function isSignificantSchemaChange(result: SchemaValidationResult): boolean {
  // Missing critical top-level fields is significant
  if (result.missingFields && result.missingFields.length > 0) {
    return true;
  }

  // Type errors on required fields are significant
  if (result.typeErrors) {
    for (const errorKey of Object.keys(result.typeErrors)) {
      if (errorKey.includes('events') || errorKey.includes('elements')) {
        return true;
      }
    }
  }

  return false;
}
