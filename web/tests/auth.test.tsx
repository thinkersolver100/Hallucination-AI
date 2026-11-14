import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SESSION } from './helpers/fixtures';
import { mockApi, renderApp } from './helpers/mockApi';

const unauthorized = { status: 401, body: { error: { code: 'unauthorized', message: 'authentication required' } } };

describe('authentication', () => {
  it('sends an anonymous visitor to the sign-in page', async () => {
    mockApi({ 'GET /auth/me': unauthorized });
    renderApp('/datasets');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('signs in and lands on the page that was requested', async () => {
    const { calls } = mockApi({
      'GET /auth/me': unauthorized,
      'POST /auth/login': { status: 200, body: SESSION },
      'GET /datasets': { status: 200, body: { datasets: [] } },
    });
    const user = userEvent.setup();
    renderApp('/datasets');

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Datasets' })).toBeInTheDocument();
    expect(screen.getByText(/ada@example.com · Acme/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({
      email: 'ada@example.com',
      password: 'correct horse battery',
    });
  });

  it('shows the server message for wrong credentials and stays on the page', async () => {
    mockApi({
      'GET /auth/me': unauthorized,
      'POST /auth/login': { status: 401, body: { error: { code: 'unauthorized', message: 'invalid email or password' } } },
    });
    const user = userEvent.setup();
    renderApp('/login');

    await user.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('invalid email or password');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('creates an account', async () => {
    const { calls } = mockApi({
      'GET /auth/me': unauthorized,
      'POST /auth/register': { status: 201, body: SESSION },
      'GET /datasets': { status: 200, body: { datasets: [] } },
    });
    const user = userEvent.setup();
    renderApp('/login');

    await user.click(await screen.findByRole('button', { name: /Need an account/ }));
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'a long enough password');
    await user.type(screen.getByLabelText('Organization name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('heading', { name: 'Datasets' })).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/auth/register')?.body).toEqual({
      email: 'ada@example.com',
      password: 'a long enough password',
      organizationName: 'Acme',
    });
  });

  it('explains when registration is closed', async () => {
    mockApi({
      'GET /auth/me': unauthorized,
      'POST /auth/register': { status: 403, body: { error: { code: 'registration_closed', message: 'registration is closed' } } },
    });
    const user = userEvent.setup();
    renderApp('/login');

    await user.click(await screen.findByRole('button', { name: /Need an account/ }));
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('Password'), 'a long enough password');
    await user.type(screen.getByLabelText('Organization name'), 'Acme');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Registration is closed on this server');
  });

  it('signs out and returns to the sign-in page', async () => {
    const { calls } = mockApi({
      'GET /auth/me': { status: 200, body: SESSION },
      'GET /datasets': { status: 200, body: { datasets: [] } },
      'POST /auth/logout': { status: 204 },
    });
    const user = userEvent.setup();
    renderApp('/datasets');

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/auth/logout')).toBe(true);
  });

  it('returns to the sign-in page when the session expires mid-use', async () => {
    mockApi({
      'GET /auth/me': { status: 200, body: SESSION },
      'GET /datasets': unauthorized,
    });
    renderApp('/datasets');

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument());
  });
});
