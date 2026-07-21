import { describe, expect, it } from "vitest";
import {
  canGoBack,
  canGoForward,
  createHistory,
  currentUrl,
  DEFAULT_BROWSER_URL,
  goBack,
  goForward,
  normalizeUrl,
  pushUrl,
} from "../lib/browserHistory";

describe("browserHistory", () => {
  it("starts with a single entry", () => {
    const h = createHistory("http://localhost:3000");
    expect(currentUrl(h)).toBe("http://localhost:3000");
    expect(canGoBack(h)).toBe(false);
    expect(canGoForward(h)).toBe(false);
  });

  it("push drops forward entries (standard browser semantics)", () => {
    let h = createHistory("http://a");
    h = pushUrl(h, "http://b");
    h = pushUrl(h, "http://c");
    h = goBack(h); // at b
    h = pushUrl(h, "http://d"); // c must be discarded
    expect(h.stack).toEqual(["http://a", "http://b", "http://d"]);
    expect(canGoForward(h)).toBe(false);
  });

  it("back/forward move the index and respect the ends", () => {
    let h = createHistory("http://a");
    h = pushUrl(h, "http://b");
    h = goBack(h);
    expect(currentUrl(h)).toBe("http://a");
    expect(canGoBack(h)).toBe(false);
    h = goBack(h); // no-op at start
    expect(currentUrl(h)).toBe("http://a");
    h = goForward(h);
    expect(currentUrl(h)).toBe("http://b");
    h = goForward(h); // no-op at end
    expect(currentUrl(h)).toBe("http://b");
  });

  it("normalizeUrl adds http:// to bare hosts and keeps explicit schemes", () => {
    expect(normalizeUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeUrl("  ")).toBe(DEFAULT_BROWSER_URL);
  });

  it("omnibox: search queries go to the search engine, not http://", () => {
    expect(normalizeUrl("react hooks tutorial")).toBe(
      "https://www.bing.com/search?q=react%20hooks%20tutorial",
    );
    expect(normalizeUrl("tubeforge")).toBe("https://www.bing.com/search?q=tubeforge");
    // host-looking inputs still navigate directly
    expect(normalizeUrl("example.com/docs")).toBe("http://example.com/docs");
    expect(normalizeUrl("127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(normalizeUrl("localhost")).toBe("http://localhost");
  });
});
