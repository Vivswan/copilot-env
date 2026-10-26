// A fetch stub's call log reads the address off whichever of `fetch`'s three input spellings the
// caller passed, so a test asserts on one string whatever the code under test built.

/** The URL a fetch input addresses: the string itself, a URL's href, or a Request's url. */
export function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
