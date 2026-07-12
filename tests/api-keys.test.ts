// Unit tests for lib/api-keys.ts — the tracker webhook's key generation,
// hashing, and constant-time verification. Every function under test is
// pure (no DB, no network), so these run with plain fixtures only.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { generateApiKey, hashApiKey, verifyApiKey, isValidApiKeyShape } from '@/lib/api-keys';

describe('generateApiKey', () => {
  it('produces a raw key shaped fiq_ + 32 lowercase hex characters (36 total)', () => {
    const { raw } = generateApiKey();
    expect(raw).toMatch(/^fiq_[0-9a-f]{32}$/);
    expect(raw).toHaveLength(36);
  });

  it('produces a different raw key on every call (16 random bytes)', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.raw).not.toBe(b.raw);
  });

  it("returns a hash that is the raw key's own sha256 hex digest", () => {
    const { raw, hash } = generateApiKey();
    expect(hash).toBe(createHash('sha256').update(raw).digest('hex'));
  });
});

describe('hashApiKey', () => {
  it('matches an independently recomputed sha256 hex digest of the same input', () => {
    const raw = 'fiq_00112233445566778899aabbccddeeff';
    expect(hashApiKey(raw)).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('is deterministic — same input always produces the same hash', () => {
    const raw = 'fiq_00112233445566778899aabbccddeeff';
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
  });
});

describe('verifyApiKey', () => {
  it('returns true for the raw key that produced the stored hash', () => {
    const { raw, hash } = generateApiKey();
    expect(verifyApiKey(raw, hash)).toBe(true);
  });

  it('returns false for a completely different raw key', () => {
    const { hash } = generateApiKey();
    const other = generateApiKey();
    expect(verifyApiKey(other.raw, hash)).toBe(false);
  });

  it('returns false when only the last character of the raw key is tampered with', () => {
    const { raw, hash } = generateApiKey();
    const lastChar = raw.at(-1)!;
    const tamperedChar = lastChar === '0' ? '1' : '0';
    const tampered = raw.slice(0, -1) + tamperedChar;
    expect(verifyApiKey(tampered, hash)).toBe(false);
  });
});

describe('isValidApiKeyShape', () => {
  it('accepts a well-formed generated key', () => {
    const { raw } = generateApiKey();
    expect(isValidApiKeyShape(raw)).toBe(true);
  });

  it.each([
    '',
    'not-a-key',
    'fiq_tooshort',
    'fiq_' + '0'.repeat(31), // one hex char short
    'fiq_' + '0'.repeat(33), // one hex char too many
    'FIQ_' + '0'.repeat(32), // wrong case prefix
    'xiq_' + '0'.repeat(32), // wrong prefix
  ])('rejects malformed candidate %j', (candidate) => {
    expect(isValidApiKeyShape(candidate)).toBe(false);
  });
});
