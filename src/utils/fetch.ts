/** THE default behind every injectable fetch seam (`opts.fetchImpl ?? defaultFetch`). An arrow
 *  over globalThis.fetch rather than the function itself: the global is read at call time, so a
 *  module-level seam sees a test's stub, and the plain signature takes any stub without
 *  `.preconnect`. */
export const defaultFetch = (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => globalThis.fetch(input, init);
