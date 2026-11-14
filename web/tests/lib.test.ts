import { describe, expect, it } from 'vitest';
import { missingReferences, parseCasesJsonl, policyIdFromFilename, readPolicyFiles } from '../src/lib/cases';
import { fixed, money, pct } from '../src/lib/format';

const line = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'ECOM-001',
    question: 'Can I return it?',
    expected_answer: 'Yes.',
    reference_doc_ids: [],
    abstention_allowed: false,
    risk_level: 'low',
    category: 'answerable',
    ...overrides,
  });

describe('parseCasesJsonl', () => {
  it('parses valid lines and ignores blank ones', () => {
    const text = `${line()}\n\n${line({ id: 'ECOM-002' })}\n`;
    const { cases, errors } = parseCasesJsonl(text);
    expect(errors).toEqual([]);
    expect(cases.map((c) => c.id)).toEqual(['ECOM-001', 'ECOM-002']);
  });

  it('reports the line number of invalid JSON', () => {
    const { errors, cases } = parseCasesJsonl(`${line()}\n{not json}\n`);
    expect(errors).toEqual(['line 2: not valid JSON']);
    expect(cases).toHaveLength(1);
  });

  it('rejects missing fields, wrong types, bad enums and unknown fields', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ id: 'has space' }, 'id must be'],
      [{ question: '   ' }, 'question must be'],
      [{ abstention_allowed: 'yes' }, 'abstention_allowed'],
      [{ risk_level: 'extreme' }, 'risk_level'],
      [{ category: '' }, 'category'],
      [{ reference_doc_ids: ['bad id!'] }, 'reference_doc_ids'],
      [{ surprise: 1 }, 'unknown field'],
    ];
    for (const [override, message] of cases) {
      const { errors } = parseCasesJsonl(line(override));
      expect(errors[0], JSON.stringify(override)).toContain(message);
    }
  });

  it('flags duplicate ids and empty files', () => {
    expect(parseCasesJsonl(`${line()}\n${line()}`).errors).toEqual(['line 2: duplicate id ECOM-001']);
    expect(parseCasesJsonl('').errors).toEqual(['the file contains no cases']);
  });

  it('refuses more cases than the API accepts', () => {
    const text = Array.from({ length: 1001 }, (_, i) => line({ id: `Q${i}` })).join('\n');
    expect(parseCasesJsonl(text).errors.some((e) => e.includes('too many cases'))).toBe(true);
  });

  it('caps the number of reported errors', () => {
    const text = Array.from({ length: 30 }, () => '{bad').join('\n');
    expect(parseCasesJsonl(text).errors.length).toBeLessThanOrEqual(11);
  });
});

describe('policy files', () => {
  it('derives ids from file names the API accepts', () => {
    expect(policyIdFromFilename('returns-policy-v1.md')).toBe('returns-policy-v1');
    expect(policyIdFromFilename('notes.txt')).toBe('notes');
    expect(policyIdFromFilename('bad name.md')).toBeNull();
    expect(policyIdFromFilename('../evil.md')).toBeNull();
  });

  it('reads files and reports problems per file', async () => {
    const { policies, errors } = await readPolicyFiles([
      new File(['Returns take 30 days.\n'], 'returns-v1.md'),
      new File(['   '], 'empty.md'),
      new File(['x'], 'bad name.md'),
    ]);
    expect(policies).toEqual({ 'returns-v1': 'Returns take 30 days.' });
    expect(errors).toHaveLength(2);
  });

  it('refuses policy text beyond the size limit', async () => {
    const big = 'x'.repeat(150_000);
    const { errors } = await readPolicyFiles([new File([big], 'a.md'), new File([big], 'b.md')]);
    expect(errors.some((e) => e.includes('too large'))).toBe(true);
  });

  it('finds references to documents that were not provided', () => {
    const cases = parseCasesJsonl(line({ reference_doc_ids: ['a', 'b'] })).cases;
    expect(missingReferences(cases, { a: 'text' })).toEqual(['b']);
  });
});

describe('formatting', () => {
  it('formats percentages, numbers and money', () => {
    expect(pct(0.1234)).toBe('12.3%');
    expect(pct(null)).toBe('–');
    expect(fixed(0.5)).toBe('0.500');
    expect(money(0.1234)).toBe('$0.1234');
    expect(money(12.5)).toBe('$12.50');
  });
});
