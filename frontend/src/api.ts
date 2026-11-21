import type { F16Metrics, F16Params, F16SimResponse } from './types';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function runF16Simulation(params: F16Params, force = false): Promise<F16SimResponse> {
  const resp = await fetch(apiUrl('/api/simulate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, force }),
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(data?.error || `F-16 simulation failed (${resp.status})`);
  }
  return data as F16SimResponse;
}

export async function fetchCachedCases(): Promise<F16Metrics[]> {
  const resp = await fetch(apiUrl('/api/cases'));
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data?.cases || []) as F16Metrics[];
}

export async function fetchVtpBuffer(url: string): Promise<ArrayBuffer> {
  const resp = await fetch(apiUrl(url));
  if (!resp.ok) throw new Error(`Failed loading ${url} (${resp.status})`);
  return resp.arrayBuffer();
}
