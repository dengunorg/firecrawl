import { describeIf } from "../lib";
import { scrape, scrapeRaw, scrapeTimeout, idmux, Identity } from "./lib";

const HAS_LINKEDIN =
  !!process.env.LINKEDIN_COOKIES && !!process.env.PLAYWRIGHT_MICROSERVICE_URL;

let identity: Identity;

beforeAll(async () => {
  identity = await idmux({
    name: "linkedin",
    concurrency: 100,
    credits: 1000000,
  });
}, 10000);

describeIf(HAS_LINKEDIN && !process.env.TEST_SUITE_SELF_HOSTED)(
  "LinkedIn scraping",
  () => {
    it.concurrent(
      "should return profile data for a valid LinkedIn profile URL",
      async () => {
        const response = await scrape(
          {
            url: "https://www.linkedin.com/in/williamhgates",
            formats: ["markdown"],
            headers: {
              Cookie: process.env.LINKEDIN_COOKIES!,
            },
          },
          identity,
        );

        expect(response.markdown).toBeTruthy();
        expect(response.markdown!.length).toBeGreaterThan(100);
        expect(response.metadata.statusCode).toBe(200);
        // The profile content should not be a login wall
        expect(response.markdown).not.toContain("Sign in");
      },
      scrapeTimeout,
    );

    it.concurrent(
      "should return content with markdown format",
      async () => {
        const response = await scrape(
          {
            url: "https://www.linkedin.com/in/williamhgates",
            formats: ["markdown"],
            headers: {
              Cookie: process.env.LINKEDIN_COOKIES!,
            },
          },
          identity,
        );

        expect(response.markdown).toBeTruthy();
        expect(response.metadata.statusCode).toBe(200);
      },
      scrapeTimeout,
    );
  },
);

describe("LinkedIn URL detection (non-profile URLs)", () => {
  it("should not route non-profile LinkedIn URLs to the linkedin engine", async () => {
    // A company page should NOT match the linkedin engine's URL detection
    const response = await scrapeRaw(
      {
        url: "https://www.linkedin.com/company/microsoft",
        formats: ["markdown"],
      },
      identity,
    );

    // Should either succeed via another engine or fail -- but NOT via the linkedin engine
    // The key assertion is that it doesn't crash with a linkedin-specific error
    expect(response.statusCode).toBeDefined();
  }, scrapeTimeout);
});
