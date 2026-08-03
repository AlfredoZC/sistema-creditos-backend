import { ValueTransformer } from 'typeorm';

/**
 * Maps numeric(10,2) money columns to TS strings: pg always returns
 * numerics as strings and JS floats would corrupt money precision
 * (design AD2 / section 5.1).
 */
export class DecimalTransformer implements ValueTransformer {
  to(value?: string | number | null): string | null | undefined {
    if (value === null) {
      return null;
    }
    if (value === undefined) {
      return undefined;
    }
    return String(value);
  }

  from(value: string | null | undefined): string | null | undefined {
    return value;
  }
}

export const decimalTransformer = new DecimalTransformer();
