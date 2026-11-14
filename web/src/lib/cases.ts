/** Client-side parsing of a benchmark folder. The API validates again; this is for fast feedback. */

export const MAX_CASES = 1000;
export const MAX_POLICY_CHARS = 200_000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface CaseInput {
  id: string;
  question: string;
  expected_answer: string;
  reference_doc_ids: string[];
  abstention_allowed: boolean;
  risk_level: 'low' | 'medium' | 'high';
  category: string;
}

const CASE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const POLICY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FIELDS = [
  'id',
  'question',
  'expected_answer',
  'reference_doc_ids',
  'abstention_allowed',
  'risk_level',
  'category',
] as const;
const MAX_REPORTED_ERRORS = 10;

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
}

function checkCase(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'must be a JSON object';
  const record = raw as Record<string, unknown>;
  const unknownKeys = Object.keys(record).filter((key) => !(FIELDS as readonly string[]).includes(key));
  if (unknownKeys.length > 0) return `unknown field(s): ${unknownKeys.join(', ')}`;
  if (typeof record['id'] !== 'string' || !CASE_ID.test(record['id'])) return 'id must be letters, digits, . _ - (max 64)';
  if (!isText(record['question'], 2000)) return 'question must be 1-2000 characters';
  if (!isText(record['expected_answer'], 2000)) return 'expected_answer must be 1-2000 characters';
  const refs = record['reference_doc_ids'];
  if (refs !== undefined && (!Array.isArray(refs) || refs.length > 20 || refs.some((r) => typeof r !== 'string' || !POLICY_ID.test(r)))) {
    return 'reference_doc_ids must be a list of policy document ids';
  }
  if (typeof record['abstention_allowed'] !== 'boolean') return 'abstention_allowed must be true or false';
  if (!['low', 'medium', 'high'].includes(String(record['risk_level']))) return 'risk_level must be low, medium or high';
  if (!isText(record['category'], 64)) return 'category must be 1-64 characters';
  return null;
}

export interface ParsedCases {
  cases: CaseInput[];
  errors: string[];
}

export function parseCasesJsonl(text: string): ParsedCases {
  const cases: CaseInput[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const fail = (message: string): void => {
    if (errors.length < MAX_REPORTED_ERRORS) errors.push(message);
  };

  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const where = `line ${index + 1}`;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      fail(`${where}: not valid JSON`);
      return;
    }
    const problem = checkCase(raw);
    if (problem) {
      fail(`${where}: ${problem}`);
      return;
    }
    const record = raw as CaseInput;
    if (seen.has(record.id)) {
      fail(`${where}: duplicate id ${record.id}`);
      return;
    }
    seen.add(record.id);
    cases.push({ ...record, reference_doc_ids: record.reference_doc_ids ?? [] });
  });

  if (cases.length === 0 && errors.length === 0) errors.push('the file contains no cases');
  if (cases.length > MAX_CASES) {
    errors.push(`too many cases: ${cases.length} (the limit is ${MAX_CASES})`);
  }
  return { cases, errors };
}

/** returns-policy-v1.md -> returns-policy-v1. Anything the API would refuse gives null. */
export function policyIdFromFilename(name: string): string | null {
  const id = name.replace(/\.(md|markdown|txt)$/i, '');
  return POLICY_ID.test(id) ? id : null;
}

export function readText(file: Blob): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('could not read the file'));
    reader.readAsText(file);
  });
}

export async function readPolicyFiles(
  files: File[],
): Promise<{ policies: Record<string, string>; errors: string[] }> {
  const policies: Record<string, string> = {};
  const errors: string[] = [];
  let total = 0;
  for (const file of files) {
    const id = policyIdFromFilename(file.name);
    if (!id) {
      errors.push(`${file.name}: file name must be letters, digits, - or _ (then .md or .txt)`);
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      errors.push(`${file.name}: file is too large`);
      continue;
    }
    const text = (await readText(file)).trim();
    if (!text) {
      errors.push(`${file.name}: file is empty`);
      continue;
    }
    if (id in policies) {
      errors.push(`${file.name}: duplicate policy id ${id}`);
      continue;
    }
    total += text.length;
    policies[id] = text;
  }
  if (total > MAX_POLICY_CHARS) errors.push(`policy documents are too large (${total} characters, limit ${MAX_POLICY_CHARS})`);
  return { policies, errors };
}

/** Policy ids that a case cites but that were not uploaded. */
export function missingReferences(cases: CaseInput[], policies: Record<string, string>): string[] {
  const missing = new Set<string>();
  for (const c of cases) for (const ref of c.reference_doc_ids) if (!(ref in policies)) missing.add(ref);
  return [...missing].sort();
}
