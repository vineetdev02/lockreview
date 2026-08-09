export interface HttpOptions {
  /** Wall-clock moment after which no new request should be started. */
  deadline: number;
  /** Per-request timeout in milliseconds. */
  timeout?: number;
  userAgent: string;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const DEFAULT_TIMEOUT = 10_000;

/**
 * GET JSON, or undefined when the resource does not exist.
 *
 * Enrichment is best-effort by design: a registry hiccup should cost lockdiff
 * one signal, never the whole report. Callers treat undefined as "unknown".
 */
export async function getJson<T>(url: string, options: HttpOptions): Promise<T | undefined> {
  const attempts = 2;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) return undefined;

    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": options.userAgent },
        signal: AbortSignal.timeout(Math.min(options.timeout ?? DEFAULT_TIMEOUT, remaining)),
      });

      if (response.status === 404) return undefined;
      if (response.status >= 500 && attempt < attempts) continue;
      if (!response.ok) throw new HttpError(`${url} responded ${response.status}`, response.status);

      return (await response.json()) as T;
    } catch (error) {
      if (attempt >= attempts) return undefined;
      if (error instanceof HttpError) return undefined;
    }
  }

  return undefined;
}

/** POST JSON, with the same best-effort contract as {@link getJson}. */
export async function postJson<T>(
  url: string,
  body: unknown,
  options: HttpOptions,
): Promise<T | undefined> {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) return undefined;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": options.userAgent,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.min(options.timeout ?? DEFAULT_TIMEOUT, remaining)),
    });

    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

/** Run tasks with bounded concurrency, preserving input order in the result. */
export async function pool<Input, Output>(
  items: readonly Input[],
  limit: number,
  worker: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as Input, index);
    }
  });

  await Promise.all(runners);
  return results;
}
