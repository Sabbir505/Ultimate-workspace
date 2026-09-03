import { describe, expect, it } from "vitest";
import { linkCitations, parseChatSources, sourcesFingerprint } from "../lib/chatCitations";
import { rowsFromTableNode, toCsv, toTsv } from "../components/chat/MarkdownTable";

const SOURCES_MSG = `Findings: model A wins [1], and B corroborates (1,2). Also see [3] and [4].

## Sources
1. Alpha Paper — https://alpha.example.com/paper — says X
2. [Beta Report](https://beta.example.org/report) — corroborates
3. Gamma Notes: https://gamma.example.net/notes
- 4. Delta Study https://delta.example.edu/delta.pdf extra
`;

describe("parseChatSources", () => {
  it("returns [] for content without a Sources section", () => {
    expect(parseChatSources("just [1] text")).toEqual([]);
    expect(parseChatSources("")).toEqual([]);
  });

  it("parses numbered entries with url + title (varied line styles)", () => {
    const sources = parseChatSources(SOURCES_MSG);
    expect(sources.map((s) => s.n)).toEqual([1, 2, 3, 4]);
    expect(sources[0]).toMatchObject({ n: 1, url: "https://alpha.example.com/paper" });
    expect(sources[0].title).toContain("Alpha Paper");
    // markdown-link label preferred as the title
    expect(sources[1]).toMatchObject({ n: 2, url: "https://beta.example.org/report", title: "Beta Report" });
    expect(sources[2].url).toBe("https://gamma.example.net/notes");
    expect(sources[3].url).toBe("https://delta.example.edu/delta.pdf");
  });

  it("stops at the next heading after Sources", () => {
    const msg = `${SOURCES_MSG}\n## Next Section\n5. Fake https://fake.example.com/x\n`;
    expect(parseChatSources(msg).map((s) => s.n)).toEqual([1, 2, 3, 4]);
  });

  it("prefers the LAST Sources heading", () => {
    const msg = "## Sources\n1. stale https://stale.example.com/a\n\n## Sources\n2. fresh https://fresh.example.com/b\n";
    expect(parseChatSources(msg).map((s) => s.n)).toEqual([2]);
  });

  it("parses numbered / bold heading variants models actually emit", () => {
    const entry = "1. Alpha Paper https://alpha.example.com/paper\n";
    for (const heading of [
      "### 6. Source References",
      "## 6. Source References",
      "**Source References**",
      "**Sources**",
      "Sources:",
      "## Sources & References",
      "The Sources",
    ]) {
      const sources = parseChatSources(`${heading}\n${entry}`);
      expect(sources.map((s) => s.n), heading).toEqual([1]);
      expect(sources[0].url, heading).toBe("https://alpha.example.com/paper");
    }
  });

  it("does not treat prose that merely mentions sources as a heading", () => {
    expect(parseChatSources("Let me verify these sources.\n\n1. fake https://x.example.com/a")).toEqual([]);
    expect(parseChatSources("I checked several sources online today for this topic.")).toEqual([]);
  });

  it("falls back to the hostname when no title text remains", () => {
    const sources = parseChatSources("## Sources\n1. https://docs.example.com/guide\n");
    expect(sources[0].title).toBe("docs.example.com");
  });
});

describe("linkCitations", () => {
  const sources = parseChatSources(SOURCES_MSG);

  it("rewrites resolved bracket citations", () => {
    expect(linkCitations("claim [1] here", sources)).toBe("claim [1](cite:1) here");
    expect(linkCitations("claim [1, 2] here", sources)).toBe("claim [1,2](cite:1,2) here");
  });

  it("rewrites multi-number paren citations (1,2)", () => {
    expect(linkCitations("corroborates (1,2) yes", sources)).toBe("corroborates [1,2](cite:1,2) yes");
  });

  it("rewrites adjacent bracket citations [3][4]", () => {
    expect(linkCitations("see [3][4] now", sources)).toBe("see [3](cite:3)[4](cite:4) now");
  });

  it("leaves content untouched when there are no sources", () => {
    const raw = "text [1] and (1,2)";
    expect(linkCitations(raw, [])).toBe(raw);
  });

  it("leaves unresolved numbers as plain text", () => {
    expect(linkCitations("cite [9] only and (7) too", sources)).toBe("cite [9] only and (7) too");
  });

  it("does not convert single-number paren enumerations", () => {
    expect(linkCitations("step (2) does X", sources)).toBe("step (2) does X");
  });

  it("does not rewrite citations inside fenced code blocks or inline code", () => {
    const fencedBody = "```py\nx = arr[1]\n```";
    const out = linkCitations(`${fencedBody}\nsee [1]`, sources);
    // The fence keeps its content verbatim; the citation AFTER it converts.
    expect(out).toContain(fencedBody);
    expect(out).toContain("see [1](cite:1)");
    const inline = "use `arr[1]` then cite [1]";
    const out2 = linkCitations(inline, sources);
    expect(out2).toContain("`arr[1]`");
    expect(out2).toContain("(cite:1)");
  });

  it("does not rewrite the number inside an existing markdown link target", () => {
    const out = linkCitations("[see 1](https://x.com/a) plus [1]", sources);
    expect(out).toContain("[see 1](https://x.com/a)");
    expect(out).toContain("(cite:1)");
  });

  it("restores protected regions (no placeholder leakage)", () => {
    const out = linkCitations("a `c[1]` b [1]", sources);
    expect(out).not.toContain("\u0000");
  });
});

describe("sourcesFingerprint", () => {
  it("is empty for no sources and differs per url set", () => {
    const s = parseChatSources(SOURCES_MSG);
    expect(sourcesFingerprint([])).toBe("");
    expect(sourcesFingerprint(undefined)).toBe("");
    expect(sourcesFingerprint(s)).not.toBe(sourcesFingerprint(s.slice(0, 2)));
  });
});

describe("table extraction", () => {
  const cell = (v: string) => ({ type: "element", tagName: "td", children: [{ type: "text", value: v }] });
  const table = {
    type: "element",
    tagName: "table",
    children: [
      {
        type: "element",
        tagName: "thead",
        children: [
          {
            type: "element",
            tagName: "tr",
            children: [cell("Name"), cell("Value")],
          },
        ],
      },
      {
        type: "element",
        tagName: "tbody",
        children: [
          { type: "element", tagName: "tr", children: [cell("a,b"), cell("1")] },
          { type: "element", tagName: "tr", children: [cell("C"), cell("2")] },
        ],
      },
    ],
  };

  it("extracts rows of plain text from the hast table node", () => {
    expect(rowsFromTableNode(table as never)).toEqual([
      ["Name", "Value"],
      ["a,b", "1"],
      ["C", "2"],
    ]);
  });

  it("serializes to CSV with quoting and TSV for spreadsheets", () => {
    expect(toCsv([["a,b", 'say "hi"'], ["C", "2"]])).toBe('"a,b","say ""hi"""\r\nC,2');
    expect(toTsv([["Name", "Value"], ["a\tb", "1"]])).toBe("Name\tValue\na b\t1");
  });
});
