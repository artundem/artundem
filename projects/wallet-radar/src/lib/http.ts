export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  label = "HTTP request",
  timeoutMs = 30_000,
  maxAttempts = 3
): Promise<T> {
  let lastError: unknown;
  const attempts = Math.max(1, Math.trunc(maxAttempts));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {})
        }
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // Keep the text body for a useful error message.
      }
      if (!response.ok) {
        const detail = typeof body === "string" ? body : JSON.stringify(body);
        throw new HttpStatusError(response.status, `${label} failed (${response.status}): ${detail.slice(0, 600)}`);
      }
      return body as T;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryable(error)) throw error;
      await delay(250 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

export function withQuery(baseUrl: string, params: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpStatusError) return error.status === 429 || error.status >= 500;
  if (error instanceof Error && error.name === "AbortError") return true;
  return error instanceof TypeError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
