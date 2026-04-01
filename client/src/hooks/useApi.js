import { useState, useCallback } from 'react';
import { getToken, clearToken } from '../utils/auth';

export function useApi() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const request = useCallback(async (url, options = {}) => {
    setLoading(true);
    setError(null);

    const token = getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    };

    try {
      const res = await fetch(`/api${url}`, { ...options, headers });

      if (res.status === 401) {
        clearToken();
        window.location.href = '/login';
        return null;
      }

      const data = await res.json();

      if (!res.ok) {
        const err = new Error(data.error || 'Request failed');
        err.code = data.code;
        throw err;
      }

      return data;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { request, loading, error, setError };
}
