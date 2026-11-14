import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { dataset, SESSION } from './helpers/fixtures';
import { mockApi, renderApp } from './helpers/mockApi';

const caseLine = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    id,
    question: `Question ${id}?`,
    expected_answer: 'Yes.',
    reference_doc_ids: ['returns-v1'],
    abstention_allowed: false,
    risk_level: 'low',
    category: 'answerable',
    ...extra,
  });

const base = { 'GET /auth/me': { status: 200, body: SESSION } };

describe('datasets page', () => {
  it('lists datasets with their details', async () => {
    mockApi({ ...base, 'GET /datasets': { status: 200, body: { datasets: [dataset()] } } });
    renderApp('/datasets');

    const row = (await screen.findByRole('row', { name: /Northwind starter/ }));
    expect(within(row).getByText('Northwind Home Goods')).toBeInTheDocument();
    expect(within(row).getByText('30')).toBeInTheDocument();
    expect(within(row).getByText('returns-policy-v1, shipping-policy-v1')).toBeInTheDocument();
  });

  it('imports a dataset from a questions file and policy files', async () => {
    let listed = [] as ReturnType<typeof dataset>[];
    const { calls } = mockApi({
      ...base,
      'GET /datasets': () => ({ status: 200, body: { datasets: listed } }),
      'POST /datasets': () => {
        listed = [dataset({ name: 'My set', caseCount: 2 })];
        return { status: 201, body: listed[0] };
      },
    });
    const user = userEvent.setup();
    renderApp('/datasets');

    await user.type(await screen.findByLabelText('Name'), 'My set');
    await user.type(screen.getByLabelText(/Company name/), 'Acme Co');
    await user.upload(
      screen.getByLabelText(/Questions file/),
      new File([`${caseLine('ECOM-001')}\n${caseLine('ECOM-002')}\n`], 'cases.jsonl'),
    );
    await user.upload(screen.getByLabelText(/Policy documents/), new File(['Returns take 30 days.'], 'returns-v1.md'));

    expect(await screen.findByText(/Ready to import: 2 questions, 1 policy documents/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Import dataset' }));

    expect(await screen.findByText(/Imported “My set” \(2 questions, 1 policy documents\)/)).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST' && c.path === '/datasets');
    expect(post?.body).toMatchObject({
      name: 'My set',
      companyName: 'Acme Co',
      policies: { 'returns-v1': 'Returns take 30 days.' },
    });
    expect((post?.body as { cases: unknown[] }).cases).toHaveLength(2);
    expect(await screen.findByRole('row', { name: /My set/ })).toBeInTheDocument();
  });

  it('shows problems in the questions file and keeps the import disabled', async () => {
    mockApi({ ...base, 'GET /datasets': { status: 200, body: { datasets: [] } } });
    const user = userEvent.setup();
    renderApp('/datasets');

    await user.type(await screen.findByLabelText('Name'), 'Broken');
    await user.upload(screen.getByLabelText(/Questions file/), new File([`${caseLine('A')}\n{not json}\n`], 'cases.jsonl'));

    expect(await screen.findByText('line 2: not valid JSON')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import dataset' })).toBeDisabled();
  });

  it('flags cases that cite policy documents which were not selected', async () => {
    mockApi({ ...base, 'GET /datasets': { status: 200, body: { datasets: [] } } });
    const user = userEvent.setup();
    renderApp('/datasets');

    await user.type(await screen.findByLabelText('Name'), 'Missing policy');
    await user.upload(screen.getByLabelText(/Questions file/), new File([caseLine('A')], 'cases.jsonl'));

    expect(await screen.findByText(/cite policy documents that were not selected: returns-v1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import dataset' })).toBeDisabled();

    await user.upload(screen.getByLabelText(/Policy documents/), new File(['text'], 'returns-v1.md'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import dataset' })).toBeEnabled());
  });

  it('shows what the server rejected', async () => {
    mockApi({
      ...base,
      'GET /datasets': { status: 200, body: { datasets: [] } },
      'POST /datasets': { status: 409, body: { error: { code: 'limit_reached', message: 'an organization can hold at most 50 datasets' } } },
    });
    const user = userEvent.setup();
    renderApp('/datasets');

    await user.type(await screen.findByLabelText('Name'), 'Set');
    await user.upload(screen.getByLabelText(/Questions file/), new File([caseLine('A', { reference_doc_ids: [] })], 'c.jsonl'));
    await user.click(await screen.findByRole('button', { name: 'Import dataset' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('at most 50 datasets');
  });

  it('deletes a dataset only after confirmation', async () => {
    const { calls } = mockApi({
      ...base,
      'GET /datasets': { status: 200, body: { datasets: [dataset()] } },
      [`DELETE /datasets/${dataset().id}`]: { status: 204 },
    });
    const user = userEvent.setup();
    renderApp('/datasets');
    const button = await screen.findByRole('button', { name: 'Delete' });

    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await user.click(button);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    await user.click(button);
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('explains why a dataset in use cannot be deleted', async () => {
    mockApi({
      ...base,
      'GET /datasets': { status: 200, body: { datasets: [dataset()] } },
      [`DELETE /datasets/${dataset().id}`]: {
        status: 409,
        body: { error: { code: 'in_use', message: 'delete the experiments that use this dataset first' } },
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderApp('/datasets');

    await user.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('delete the experiments that use this dataset first');
  });
});
