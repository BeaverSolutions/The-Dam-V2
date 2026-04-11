import { useState, useCallback } from 'react';
import { clearToken } from '../utils/auth';

// Transient gateway/infra error codes that deserve an auto-retry.
// 502/503/504 = Railway / Supabase pool / Claude API timeout bleeding through.
// 408 = request timeout. 429 = rate-limited (short backoff OK).
const RETRIABLE_STATUS = new Set([408, 429, 502, 503, 504]);
const RETRY_DELAY_MS = 2000;

// Friendly message for transient server blips — no more "Unexpected token 'S'".
function friendlyGatewayError(status) {
  if (status === 502 || status === 503) return 'Server blip — Railway or Supabase is briefly unavailable. Please retry.';
  if (status === 504) return 'Server took too long to respond. The request may still be running in the background — retry in a moment.';
  if (status === 429) return 'Slow down — the server is rate-limiting this endpoint. Wait a few seconds and retry.';
  if (status === 408) return 'Request timed out. Retry.';
  return `Server returned status ${status}. Retry in a moment.`;
}

/**
 * Parse a fetch response body safely. Handles three cases:
 *   1. Content-Type is JSON → parse normally
 *   2. Content-Type is HTML / text → it's a gateway error page, return null + raw text
 *   3. Empty body → return null
 * Never throws "Unexpected token 'S'" — that was the old bug.
 */
async function safeParseResponse(res) {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return { json: await res.json(), isJson: true, rawText: null };
    } catch {
      // Malformed JSON with correct header — treat as gateway error
      return { json: null, isJson: false, rawText: '(malformed JSON)' };
    }
  }
  // Non-JSON response (HTML error page, plain text, empty)
  const text = await res.text().catch(() => '');
  return { json: null, isJson: false, rawText: text.slice(0, 200) };
}

export function useApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const request = useCallback(async (url, options = {}, { _retry = 0 } = {}) => {
    if (_retry === 0) {
      setLoading(true);
      setError(null);
    }

    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    try {
      const res = await fetch(`/api${url}`, { ...options, headers, credentials: 'include' });

      if (res.status === 401) {
        clearToken();
        window.location.href = '/login';
        return null;
      }

      const { json, isJson, rawText } = await safeParseResponse(res);

      // ── Successful JSON response ──
      if (res.ok && isJson) {
        if (_retry > 0) console.log(`[api] ${url} succeeded on retry ${_retry}`);
        return json;
      }

      // ── Gateway / infrastructure failure (HTML page or non-JSON body) ──
      // Auto-retry once on RETRIABLE statuses before surfacing the error.
      if (!isJson && RETRIABLE_STATUS.has(res.status) && _retry === 0) {
        console.warn(`[api] ${url} → HTTP ${res.status} (non-JSON body). Auto-retrying in ${RETRY_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        return request(url, options, { _retry: 1 });
      }

      // ── Non-JSON body + non-retriable (or retry already exhausted) ──
      if (!isJson) {
        const msg = friendlyGatewayError(res.status);
        console.warn(`[api] ${url} → HTTP ${res.status} non-JSON. Raw: ${rawText}`);
        const err = new Error(msg);
        err.status = res.status;
        err.raw = rawText;
        err.transient = RETRIABLE_STATUS.has(res.status);
        throw err;
      }

      // ── JSON body but non-2xx status (app-level error like validation fail) ──
      const err = new Error(json?.error || `Request failed (HTTP ${res.status})`);
      err.code = json?.code;
      err.status = res.status;
      throw err;
    } catch (err) {
      // Network errors (fetch itself rejected) also deserve a retry once.
      // `err.status` is undefined on real network failures.
      if (!err.status && _retry === 0 && err.name !== 'AbortError') {
        console.warn(`[api] ${url} network error: ${err.message}. Retrying once...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        try {
          return await request(url, options, { _retry: 1 });
        } catch (retryErr) {
          setError(retryErr.message);
          throw retryErr;
        }
      }
      setError(err.message);
      throw err;
    } finally {
      if (_retry === 0) setLoading(false);
    }
  }, []);

  return { request, loading, error, setError };
}
