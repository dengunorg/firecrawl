import { z } from "zod";
import { config } from "../../../../config";
import { EngineScrapeResult } from "..";
import { Meta } from "../..";
import { robustFetch } from "../../lib/fetch";
import { EngineError } from "../../error";

const LINKEDIN_WAIT_MS = 5000;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Detects whether a URL is a LinkedIn personal profile page.
 * Accepts: linkedin.com/in/<username>, www.linkedin.com/in/<username>
 * Rejects: linkedin.com/company/*, linkedin.com/jobs/*, etc.
 */
export function isLinkedInProfileUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return false;
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (hostname !== "linkedin.com") {
    return false;
  }

  const segments = parsed.pathname
    .split("/")
    .filter(Boolean);

  // Must be /in/<username> with at least 2 segments
  if (segments.length < 2 || segments[0] !== "in") {
    return false;
  }

  // Username must be non-empty
  const username = segments[1];
  if (!username || username.length === 0) {
    return false;
  }

  return true;
}

/**
 * Extracts the li_at cookie value from the request headers.
 * Looks for a Cookie header containing `li_at=...`.
 */
function extractLinkedInCookie(
  headers: Record<string, string> | undefined,
): string | null {
  if (!headers) return null;

  // Check both casings for the Cookie header
  const cookieHeader =
    headers["Cookie"] ?? headers["cookie"] ?? headers["COOKIE"];
  if (!cookieHeader) return null;

  // Verify it contains li_at
  if (!cookieHeader.includes("li_at=")) return null;

  return cookieHeader;
}

/**
 * Scrapes a LinkedIn profile page via the Playwright microservice.
 * If the caller passes LinkedIn session cookies (li_at) in the request headers,
 * they will be forwarded for authenticated access. Otherwise, the scrape is
 * attempted without authentication to retrieve any publicly available info.
 */
export async function scrapeURLWithLinkedIn(
  meta: Meta,
): Promise<EngineScrapeResult> {
  const urlToScrape = meta.rewrittenUrl ?? meta.url;

  if (!isLinkedInProfileUrl(urlToScrape)) {
    throw new EngineError(
      `URL is not a supported LinkedIn profile URL: ${urlToScrape}`,
    );
  }

  if (!config.PLAYWRIGHT_MICROSERVICE_URL) {
    throw new EngineError(
      "LinkedIn engine requires PLAYWRIGHT_MICROSERVICE_URL to be configured.",
    );
  }

  const hasAuth = extractLinkedInCookie(meta.options.headers) !== null;

  meta.logger.info("Scraping LinkedIn profile via Playwright", {
    url: urlToScrape,
    authenticated: hasAuth,
  });

  // Build headers -- keep all original headers (including Cookie if provided)
  const headers: Record<string, string> = {
    ...(meta.options.headers ?? {}),
  };

  // Set a standard Chrome User-Agent if not already provided
  if (!headers["User-Agent"] && !headers["user-agent"]) {
    headers["User-Agent"] = DEFAULT_USER_AGENT;
  }

  const response = await robustFetch({
    url: config.PLAYWRIGHT_MICROSERVICE_URL,
    headers: {
      "Content-Type": "application/json",
    },
    body: {
      url: urlToScrape,
      wait_after_load: LINKEDIN_WAIT_MS,
      timeout: meta.abort.scrapeTimeout(),
      headers,
      skip_tls_verification: meta.options.skipTlsVerification,
    },
    method: "POST",
    logger: meta.logger.child("scrapeURLWithLinkedIn/robustFetch"),
    schema: z.object({
      content: z.string(),
      pageStatusCode: z.number(),
      pageError: z.string().optional(),
      contentType: z.string().optional(),
    }),
    mock: meta.mock,
    abort: meta.abort.asSignal(),
  });

  // Handle LinkedIn-specific error status codes
  if (response.pageStatusCode === 999) {
    throw new EngineError(
      "LinkedIn is blocking this request (status 999). Consider using a residential proxy or reducing request frequency.",
    );
  }

  if (response.pageStatusCode === 429) {
    throw new EngineError(
      "LinkedIn rate limit hit (status 429). Reduce request frequency.",
    );
  }

  if (response.pageStatusCode === 401 || response.pageStatusCode === 403) {
    throw new EngineError(
      `LinkedIn returned ${response.pageStatusCode}. The li_at cookie may have expired. Log in again and pass a fresh cookie in the request headers.`,
    );
  }

  // Detect login wall -- only treat as an error if cookies were provided
  // (meaning the cookie is expired/invalid). Without cookies, a partial
  // login wall is expected and we return whatever public content is available.
  if (hasAuth) {
    if (
      response.content.includes('action="/uas/login-submit"') ||
      response.content.includes('class="login__form"') ||
      (response.content.includes("/login") &&
        response.content.includes("session_key") &&
        !response.content.includes("profile-section"))
    ) {
      throw new EngineError(
        "LinkedIn returned a login wall instead of the profile. The li_at cookie may have expired or is invalid. Pass a fresh cookie in the request headers.",
      );
    }
  }

  return {
    url: urlToScrape,
    html: response.content,
    statusCode: response.pageStatusCode,
    error: response.pageError,
    contentType: response.contentType,
    proxyUsed: "basic",
  };
}

/**
 * Maximum reasonable time for a LinkedIn scrape.
 * LinkedIn pages are JS-heavy and need extra render time.
 */
export function linkedInMaxReasonableTime(_meta: Meta): number {
  return 30000;
}
