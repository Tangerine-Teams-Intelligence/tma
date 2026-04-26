// HTTP fetch helper for iCal feeds.
//
// The Stage 1 calendar source pulls iCal text via straight HTTPS GET. We do
// NOT use any iCal-specific HTTP library — RFC 5545 over HTTP is just text
// served at a stable URL. A pluggable `fetch` lets tests stub the network.

export interface IcalFetchOpts {
  /** Inject a fetch implementation. Tests pass a mock. */
  fetch?: typeof fetch;
  /** Optional headers (e.g. If-None-Match for conditional GET). */
  headers?: Record<string, string>;
}

export async function fetchIcal(url: string, opts: IcalFetchOpts = {}): Promise<string> {
  const f = opts.fetch ?? fetch;
  const res = await f(url, {
    method: "GET",
    headers: {
      Accept: "text/calendar, text/plain, */*",
      "User-Agent": "tangerine-source-calendar/0.1.0",
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`ical fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}
