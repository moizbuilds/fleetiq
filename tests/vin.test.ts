// Unit tests for lib/vin.ts — the pure VIN-shape validator and the vPIC
// response mapper. Written before lib/vin.ts exists (TDD): these fixtures
// encode vPIC's real quirks (blank strings, "Not Applicable" sentinels, "0"
// for an undecoded model year, long decimal displacement) so the mapper is
// proven against real-world garbage before app/api/vin/route.ts ever calls
// it. No network here — mapVpicResult takes a plain object, exactly what a
// parsed vPIC JSON response's `Results[0]` looks like once the route has
// already awaited the fetch.
import { describe, it, expect } from 'vitest';
import { isValidVin, mapVpicResult } from '@/lib/vin';

describe('isValidVin', () => {
  it('accepts a well-formed 17-character VIN', () => {
    expect(isValidVin('1HGCM82633A004352')).toBe(true);
  });

  it('rejects a VIN that is one character short', () => {
    expect(isValidVin('1HGCM82633A00435')).toBe(false);
  });

  it('rejects a VIN that is one character too long', () => {
    expect(isValidVin('1HGCM82633A0043522')).toBe(false);
  });

  it('rejects I, O, and Q even at valid length', () => {
    expect(isValidVin('1HGCM8263IA004352')).toBe(false);
    expect(isValidVin('1HGCM8263OA004352')).toBe(false);
    expect(isValidVin('1HGCM8263QA004352')).toBe(false);
  });

  it('accepts a lowercase VIN via internal uppercasing', () => {
    expect(isValidVin('1hgcm82633a004352')).toBe(true);
  });

  it('accepts a VIN with surrounding whitespace via internal trimming', () => {
    expect(isValidVin('  1HGCM82633A004352  ')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidVin('')).toBe(false);
  });
});

describe('mapVpicResult — full fixture', () => {
  // Modeled on a real vPIC DecodeVinValues response (verified against the
  // live API): every field vPIC actually decoded is present, no sentinels.
  const FULL_FIXTURE: Record<string, string> = {
    VIN: 'JTMHY7AJ7GK123456',
    Make: 'TOYOTA',
    Model: 'Land Cruiser',
    ModelYear: '2020',
    DisplacementL: '2.8',
    EngineCylinders: '4',
    FuelTypePrimary: 'Diesel',
    EngineModel: '1GD-FTV',
    ErrorCode: '0',
    ErrorText: '0 - VIN decoded clean. Check Digit (9th position) is correct',
  };

  it('maps every field to its VinDecodeResult equivalent', () => {
    const result = mapVpicResult(FULL_FIXTURE);
    expect(result.vin).toBe('JTMHY7AJ7GK123456');
    expect(result.make).toBe('TOYOTA');
    expect(result.model).toBe('Land Cruiser');
    expect(result.year).toBe(2020);
  });

  it('composes the engine string from displacement + cylinders + fuel + model', () => {
    const result = mapVpicResult(FULL_FIXTURE);
    expect(result.engine).toBe('2.8L 4-cyl Diesel 1GD-FTV');
  });

  it('keeps the full raw payload for the "mixed" decode case', () => {
    const result = mapVpicResult(FULL_FIXTURE);
    expect(result.raw).toBe(FULL_FIXTURE);
  });

  it('rounds a long-decimal displacement (as vPIC actually returns it) to one decimal place', () => {
    // Real vPIC responses report DisplacementL as e.g. "2.998832712", not a
    // clean "3.0" — this is the exact value returned for a live VIN lookup.
    const result = mapVpicResult({ ...FULL_FIXTURE, DisplacementL: '2.998832712' });
    expect(result.engine).toBe('3.0L 4-cyl Diesel 1GD-FTV');
  });
});

describe('mapVpicResult — sparse fixture (vPIC blanks/sentinels)', () => {
  // vPIC's three "no data" quirks in one fixture: empty string, the literal
  // "Not Applicable" sentinel, and "0" for a model year it couldn't decode.
  const SPARSE_FIXTURE: Record<string, string> = {
    VIN: '1HGCM82633A004352',
    Make: 'HONDA',
    Model: '',
    ModelYear: '0',
    DisplacementL: 'Not Applicable',
    EngineCylinders: '',
    FuelTypePrimary: 'Not Applicable',
    EngineModel: '',
    ErrorCode: '1',
    ErrorText: 'Check digit does not match',
  };

  it('normalizes empty strings to null', () => {
    expect(mapVpicResult(SPARSE_FIXTURE).model).toBeNull();
  });

  it('normalizes "Not Applicable" to null', () => {
    const result = mapVpicResult(SPARSE_FIXTURE);
    expect(result.engine).toBeNull();
  });

  it('normalizes ModelYear "0" to null (vPIC could not decode a year)', () => {
    expect(mapVpicResult(SPARSE_FIXTURE).year).toBeNull();
  });

  it('still passes through fields vPIC did decode', () => {
    expect(mapVpicResult(SPARSE_FIXTURE).make).toBe('HONDA');
  });

  it('is null (not an empty string) for engine when every composing field is blank', () => {
    expect(mapVpicResult(SPARSE_FIXTURE).engine).toBeNull();
  });
});

describe('mapVpicResult — engine composition, partial cases', () => {
  const base = { VIN: 'X', Make: 'X', Model: 'X', ModelYear: '2020' };

  it('composes from displacement alone', () => {
    const result = mapVpicResult({ ...base, DisplacementL: '1.6' });
    expect(result.engine).toBe('1.6L');
  });

  it('composes from cylinders alone', () => {
    const result = mapVpicResult({ ...base, EngineCylinders: '4' });
    expect(result.engine).toBe('4-cyl');
  });

  it('composes displacement + fuel with no cylinders (no double space)', () => {
    const result = mapVpicResult({ ...base, DisplacementL: '2.0', FuelTypePrimary: 'Gasoline' });
    expect(result.engine).toBe('2.0L Gasoline');
  });

  it('is null when the raw object has none of the four composing fields at all', () => {
    const result = mapVpicResult(base);
    expect(result.engine).toBeNull();
  });
});
