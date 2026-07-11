import type {
  AccountType,
  Api,
  AuthResponse,
  BudgetCadence,
  MeResponse,
  TransferInput,
  TxFilter,
  TxInput,
  TxType,
  User,
} from '../shared/types';
import { setCurrency as applyCurrency } from './format';

// CSRF token for mutating requests; refreshed on me/login/register/google.
let csrfToken = '';

// Keep the money formatter in sync with the signed-in user's preference.
function syncCurrency(user: User | null): void {
  if (user) applyCurrency(user.currency);
}

export function setCsrf(token: string): void {
  csrfToken = token;
}

/** Fired when the API returns 401 (session expired / logged out elsewhere). */
export const AUTH_EXPIRED_EVENT = 'st:auth-expired';

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data: { error?: string } | null = null;
  try {
    data = (await res.json()) as { error?: string };
  } catch {
    // non-JSON response (proxy error page etc.)
  }

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
    }
    throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  }
  return data as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api: Api = {
  auth: {
    me: async () => {
      const r = await http<MeResponse>('GET', '/auth/me');
      setCsrf(r.csrf);
      syncCurrency(r.user);
      return r;
    },
    register: async (email, password, name) => {
      const r = await http<AuthResponse>('POST', '/auth/register', { email, password, name });
      setCsrf(r.csrf);
      syncCurrency(r.user);
      return r;
    },
    login: async (email, password) => {
      const r = await http<AuthResponse>('POST', '/auth/login', { email, password });
      setCsrf(r.csrf);
      syncCurrency(r.user);
      return r;
    },
    google: async (credential) => {
      const r = await http<AuthResponse>('POST', '/auth/google', { credential });
      setCsrf(r.csrf);
      syncCurrency(r.user);
      return r;
    },
    logout: async () => {
      await http<{ ok: boolean }>('POST', '/auth/logout');
      setCsrf('');
    },
    forgot: async (email) => {
      await http<{ ok: boolean }>('POST', '/auth/forgot', { email });
    },
    reset: async (token, password) => {
      const r = await http<AuthResponse>('POST', '/auth/reset', { token, password });
      setCsrf(r.csrf);
      syncCurrency(r.user);
      return r;
    },
    verify: async (code) => {
      const r = await http<AuthResponse>('POST', '/auth/verify', { code });
      setCsrf(r.csrf);
      syncCurrency(r.user);
      return r;
    },
    verifyLink: async (token) => {
      const r = await http<AuthResponse>('POST', '/auth/verify-link', { token });
      setCsrf(r.csrf);
      syncCurrency(r.user);
      return r;
    },
    resendVerification: async () => {
      await http<{ ok: boolean }>('POST', '/auth/resend-verification');
    },
    changePassword: async (currentPassword, newPassword) => {
      await http<{ ok: boolean }>('POST', '/auth/change-password', { currentPassword, newPassword });
    },
    setCurrency: async (currency) => {
      const r = await http<{ ok: boolean; currency: string }>('POST', '/auth/currency', { currency });
      applyCurrency(r.currency);
      return r.currency;
    },
    deleteAccount: async (currentPassword) => {
      await http<{ ok: boolean }>('POST', '/auth/delete-account', { currentPassword });
      setCsrf(''); // the session died with the account
    },
  },
  categories: {
    list: () => http('GET', '/categories'),
    create: (data: { name: string; type: TxType; color: string }) =>
      http('POST', '/categories', data),
    update: (id: number, data: { name: string; color: string }) =>
      http('PUT', `/categories/${id}`, data),
    remove: (id: number) => http('DELETE', `/categories/${id}`),
  },
  accounts: {
    list: () => http('GET', '/accounts'),
    create: (data: {
      name: string;
      type: AccountType;
      color: string;
      image: string | null;
      openingBalanceCents: number;
    }) => http('POST', '/accounts', data),
    update: (
      id: number,
      data: { name: string; color: string; image: string | null; openingBalanceCents: number }
    ) => http('PUT', `/accounts/${id}`, data),
    remove: (id: number) => http('DELETE', `/accounts/${id}`),
  },
  transfers: {
    list: (month?: string) => http('GET', `/transfers${qs({ month })}`),
    create: (data: TransferInput) => http('POST', '/transfers', data),
    update: (id: number, data: TransferInput) => http('PUT', `/transfers/${id}`, data),
    remove: (id: number) => http('DELETE', `/transfers/${id}`),
  },
  transactions: {
    list: (filter: TxFilter) =>
      http(
        'GET',
        `/transactions${qs({
          month: filter.month,
          from: filter.from,
          to: filter.to,
          type: filter.type === 'all' ? undefined : filter.type,
          categoryId: filter.categoryId === 'all' ? undefined : filter.categoryId,
          accountId: filter.accountId === 'all' ? undefined : filter.accountId,
          search: filter.search,
        })}`
      ),
    create: (data: TxInput) => http('POST', '/transactions', data),
    update: (id: number, data: TxInput) => http('PUT', `/transactions/${id}`, data),
    remove: (id: number) => http('DELETE', `/transactions/${id}`),
  },
  budgets: {
    list: () => http('GET', '/budgets'),
    upsert: (categoryId: number, cadence: BudgetCadence, amountCents: number) =>
      http('PUT', '/budgets', { categoryId, cadence, amountCents }),
  },
  reports: {
    summary: (from: string, to: string) => http('GET', `/reports/summary${qs({ from, to })}`),
    trend: (endMonth: string, count: number) =>
      http('GET', `/reports/trend${qs({ endMonth, count })}`),
    breakdown: (from: string, to: string, type: TxType) =>
      http('GET', `/reports/breakdown${qs({ from, to, type })}`),
    years: () => http('GET', '/reports/years'),
  },
};
