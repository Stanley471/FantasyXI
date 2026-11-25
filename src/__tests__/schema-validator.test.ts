import { validateFPLSchema, isSignificantSchemaChange } from '../schema-validator';

describe('Schema Validator', () => {
  describe('validateFPLSchema', () => {
    it('should validate correct FPL schema', () => {
      const validData = {
        events: [{ id: 1, name: 'GW1', deadline_time: '2024-01-01T12:00:00Z' }],
        teams: [{ id: 1, name: 'Arsenal', code: 3, short_name: 'ARS' }],
        elements: [{ id: 1, first_name: 'John', second_name: 'Doe', element_type: 1, team: 1 }],
        element_types: [{ id: 1, plural_name: 'Goalkeepers' }],
      };

      const result = validateFPLSchema(validData);
      expect(result.isValid).toBe(true);
      expect(result.missingFields).toBeUndefined();
      expect(result.typeErrors).toBeUndefined();
    });

    it('should detect missing top-level fields', () => {
      const invalidData = {
        events: [],
        teams: [],
        // missing elements and element_types
      };

      const result = validateFPLSchema(invalidData);
      expect(result.isValid).toBe(false);
      expect(result.missingFields).toContain('elements');
      expect(result.missingFields).toContain('element_types');
    });

    it('should detect type errors in array fields', () => {
      const invalidData = {
        events: 'not an array', // Should be array
        teams: [{ id: 1, name: 'Arsenal', code: 3, short_name: 'ARS' }],
        elements: [{ id: 1, first_name: 'John', second_name: 'Doe', element_type: 1, team: 1 }],
        element_types: [{ id: 1, plural_name: 'Goalkeepers' }],
      };

      const result = validateFPLSchema(invalidData);
      expect(result.isValid).toBe(false);
      expect(result.typeErrors).toBeDefined();
      expect(result.typeErrors?.['events']).toMatch(/Expected array/);
    });

    it('should detect missing required fields in array items', () => {
      const invalidData = {
        events: [{ id: 1 }], // Missing name and deadline_time
        teams: [{ id: 1, name: 'Arsenal', code: 3, short_name: 'ARS' }],
        elements: [{ id: 1, first_name: 'John', second_name: 'Doe', element_type: 1, team: 1 }],
        element_types: [{ id: 1, plural_name: 'Goalkeepers' }],
      };

      const result = validateFPLSchema(invalidData);
      expect(result.isValid).toBe(false);
      expect(result.typeErrors).toBeDefined();
      expect(Object.keys(result.typeErrors || {}).some((key) => key.includes('events'))).toBe(true);
    });

    it('should handle non-object input', () => {
      const result = validateFPLSchema('not an object');
      expect(result.isValid).toBe(false);
      expect(result.typeErrors).toBeDefined();
    });
  });

  describe('isSignificantSchemaChange', () => {
    it('should identify missing critical fields as significant', () => {
      const result = {
        isValid: false,
        missingFields: ['events', 'elements'],
      };

      expect(isSignificantSchemaChange(result)).toBe(true);
    });

    it('should identify type errors in critical fields as significant', () => {
      const result = {
        isValid: false,
        typeErrors: {
          'events.name': 'Missing required field',
          'elements.element_type': 'Type mismatch',
        },
      };

      expect(isSignificantSchemaChange(result)).toBe(true);
    });

    it('should identify non-critical type errors as not significant', () => {
      const result = {
        isValid: false,
        typeErrors: {
          'extra_field': 'Unknown field',
        },
      };

      expect(isSignificantSchemaChange(result)).toBe(false);
    });
  });
});
