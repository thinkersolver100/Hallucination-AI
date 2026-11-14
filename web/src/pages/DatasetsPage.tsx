import { useState, type ChangeEvent, type FormEvent } from 'react';
import { request } from '../api/client';
import { datasetListSchema } from '../api/types';
import { ErrorMessage } from '../components/common';
import { missingReferences, parseCasesJsonl, readPolicyFiles, readText, MAX_FILE_BYTES, type CaseInput } from '../lib/cases';
import { when } from '../lib/format';
import { useLoad } from '../lib/useLoad';

function ImportForm({ onImported }: { onImported: () => void }) {
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [cases, setCases] = useState<CaseInput[]>([]);
  const [policies, setPolicies] = useState<Record<string, string>>({});
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [caseProblems, setCaseProblems] = useState<string[]>([]);
  const [policyProblems, setPolicyProblems] = useState<string[]>([]);

  async function chooseCases(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setDone(null);
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setCases([]);
      setCaseProblems([`${file.name}: file is too large`]);
      return;
    }
    const parsed = parseCasesJsonl(await readText(file));
    setCases(parsed.errors.length > 0 ? [] : parsed.cases);
    setCaseProblems(parsed.errors);
  }

  async function choosePolicies(event: ChangeEvent<HTMLInputElement>) {
    setDone(null);
    const result = await readPolicyFiles([...(event.target.files ?? [])]);
    setPolicies(result.policies);
    setPolicyProblems(result.errors);
  }

  const missing = missingReferences(cases, policies);
  const allProblems = [
    ...caseProblems,
    ...policyProblems,
    ...(missing.length > 0 ? [`cases cite policy documents that were not selected: ${missing.join(', ')}`] : []),
  ];
  const ready = name.trim() !== '' && cases.length > 0 && allProblems.length === 0 && !busy;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await request('POST', '/datasets', {
        body: { name: name.trim(), companyName: company.trim() || 'the company', policies, cases },
      });
      setDone(`Imported “${name.trim()}” (${cases.length} questions, ${Object.keys(policies).length} policy documents).`);
      setName('');
      onImported();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Import dataset">
      <h2>Import a dataset</h2>
      <p className="muted small">
        A dataset is a questions file (<code>cases.jsonl</code>, one JSON object per line) plus the policy documents the
        agent is allowed to use. Datasets are immutable: import a new one to change it.
      </p>
      <label>
        Name
        <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Company name (used in the agent’s instructions)
        <input maxLength={120} placeholder="the company" value={company} onChange={(e) => setCompany(e.target.value)} />
      </label>
      <label>
        Questions file (.jsonl)
        <input type="file" accept=".jsonl,.json,.txt" onChange={(e) => void chooseCases(e)} />
      </label>
      <label>
        Policy documents (.md or .txt, one or more)
        <input type="file" multiple accept=".md,.markdown,.txt" onChange={(e) => void choosePolicies(e)} />
      </label>
      {(cases.length > 0 || Object.keys(policies).length > 0) && (
        <p className="muted" role="status">
          Ready to import: {cases.length} questions, {Object.keys(policies).length} policy documents.
        </p>
      )}
      {allProblems.length > 0 && (
        <div role="alert" className="alert">
          <strong>Fix these before importing:</strong>
          <ul>
            {allProblems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <ErrorMessage error={error} />
      {done && <p role="status" className="success">{done}</p>}
      <button type="submit" disabled={!ready}>
        {busy ? 'Importing…' : 'Import dataset'}
      </button>
    </form>
  );
}

export function DatasetsPage() {
  const list = useLoad(() => request('GET', '/datasets', { schema: datasetListSchema }), []);
  const [error, setError] = useState<Error | null>(null);

  async function remove(id: string, name: string) {
    if (!window.confirm(`Delete the dataset “${name}”? This cannot be undone.`)) return;
    setError(null);
    try {
      await request('DELETE', `/datasets/${id}`);
      list.reload();
    } catch (err) {
      setError(err as Error);
    }
  }

  const datasets = list.data?.datasets ?? [];
  return (
    <>
      <h1>Datasets</h1>
      <ErrorMessage error={list.error ?? error} />
      {list.loading && !list.data && <p className="muted">Loading…</p>}
      {list.data && datasets.length === 0 && <p className="muted">No datasets yet. Import one below.</p>}
      {datasets.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Company</th>
              <th className="num">Questions</th>
              <th>Policies</th>
              <th>Imported</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{d.companyName}</td>
                <td className="num">{d.caseCount}</td>
                <td>{d.policyIds.length === 0 ? '–' : d.policyIds.join(', ')}</td>
                <td>{when(d.createdAt)}</td>
                <td>
                  <button type="button" className="danger" onClick={() => void remove(d.id, d.name)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ImportForm onImported={list.reload} />
    </>
  );
}
