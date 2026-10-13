// Tests for the structured visualization layer (the `visualize` tool's
// renderer-registry surface):
//   1. parseVizPayload — every type validates; ANY structural violation
//      (wrong shape, out of bounds, non-finite numbers, hostile cells)
//      returns null so the UI renders an explicit fallback, never partial UI.
//   2. VizCard — routes through the renderer registry, renders each kind
//      from data, and falls back for unknown kinds / malformed payloads.
//   3. groupSegments — a completed viz-data marker becomes its own `viz`
//      block (answer-area placement), while the streaming marker stays a
//      live step row.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";

import { isRenderableViz, parseVizPayload, vizToCsv, type VizPayload } from "../lib/viz";
import { VizCard } from "../components/chat/viz/VizCard";
import { groupSegments } from "../components/chat/ActivitySteps";
import { parseSegments } from "../lib/segments";

const CHART = {
  viz: "chart",
  payload: {
    title: "Deploys by week",
    unit: "deploys",
    bars: [
      { label: "W1", value: 12 },
      { label: "W2", value: 9 },
      { label: "W3", value: 15 },
    ],
  },
};

const TABLE = {
  viz: "table",
  payload: {
    title: "Latency",
    columns: ["Route", { label: "p95", align: "right" }],
    rows: [
      ["/api/a", 120],
      ["/api/b", "340 ms"],
    ],
  },
};

const BOARD = {
  viz: "task-board",
  payload: {
    title: "Sprint 42",
    columns: [
      { title: "Todo", tasks: [{ title: "Design API", meta: "2d" }, { title: "Write tests" }] },
      { title: "Done", tasks: [{ title: "Spec review" }] },
    ],
  },
};

const TIMELINE = {
  viz: "timeline",
  payload: {
    title: "Incident 14:02",
    events: [
      { label: "Alert fired", detail: "p95 breached SLO", at: "14:02" },
      { label: "Rolled back", at: "14:19" },
    ],
  },
};

describe("parseVizPayload (the rendering gate)", () => {
  it("validates all four kinds", () => {
    for (const t of [CHART, TABLE, BOARD, TIMELINE]) {
      const parsed = parseVizPayload(t.viz, t.payload);
      expect(parsed, t.viz).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((parsed as any).kind).toBe(t.viz);
    }
  });

  it("rejects unknown kinds and non-object payloads", () => {
    expect(parseVizPayload("map", { x: 1 })).toBeNull();
    expect(parseVizPayload(undefined, {})).toBeNull();
    expect(parseVizPayload("chart", [1, 2])).toBeNull();
    expect(parseVizPayload("chart", "bars")).toBeNull();
  });

  it("rejects malformed charts", () => {
    expect(parseVizPayload("chart", {})).toBeNull(); // no bars
    expect(parseVizPayload("chart", { bars: [] })).toBeNull();
    expect(parseVizPayload("chart", { bars: [{ label: "a" }] })).toBeNull(); // no value
    expect(parseVizPayload("chart", { bars: [{ label: "a", value: "12" }] })).toBeNull(); // string value
    expect(parseVizPayload("chart", { bars: [{ label: "a", value: Number.NaN }] })).toBeNull();
    expect(parseVizPayload("chart", { bars: [{ label: "", value: 1 }] })).toBeNull(); // empty label
    expect(
      parseVizPayload("chart", { title: "x".repeat(121), bars: [{ label: "a", value: 1 }] }),
    ).toBeNull(); // over-long title
  });

  it("rejects malformed tables", () => {
    expect(parseVizPayload("table", { columns: [], rows: [] })).toBeNull();
    expect(parseVizPayload("table", { columns: ["a"], rows: [[1, 2]] })).toBeNull(); // width mismatch
    expect(parseVizPayload("table", { columns: [{ label: "a", align: "center" }], rows: [["x"]] })).toBeNull();
    expect(parseVizPayload("table", { columns: ["a"], rows: "nope" })).toBeNull();
    expect(parseVizPayload("table", { columns: ["a"], rows: [[{ deep: true }]] })).toBeNull(); // object cell
  });

  it("rejects malformed boards and timelines", () => {
    expect(parseVizPayload("task-board", { columns: [{ title: "c" }] })).toBeNull(); // no tasks
    expect(parseVizPayload("task-board", { columns: [{ title: "", tasks: [] }] })).toBeNull();
    expect(parseVizPayload("task-board", { columns: [{ title: "c", tasks: [{ title: "" }] }] })).toBeNull();
    expect(parseVizPayload("timeline", { events: [] })).toBeNull();
    expect(parseVizPayload("timeline", { events: [{ detail: "no label" }] })).toBeNull();
    expect(parseVizPayload("timeline", { events: [{ label: "e", at: "14:0" + "2".repeat(40) }] })).toBeNull();
  });

  it("normalizes numbers in table cells to strings", () => {
    const t = parseVizPayload("table", TABLE.payload);
    expect(t).not.toBeNull();
    expect(t?.kind === "table" && t.rows[0][1]).toBe("120");
  });

  it("isRenderableViz gates on kind viz-data + valid payload", () => {
    expect(isRenderableViz({ kind: "viz-data", viz: CHART.viz, payload: CHART.payload })).toBe(true);
    expect(isRenderableViz({ kind: "viz-data", viz: "map", payload: {} })).toBe(false);
    expect(isRenderableViz({ kind: "code", viz: "chart", payload: CHART.payload })).toBe(false);
    expect(isRenderableViz(null)).toBe(false);
  });

  // The backend's normalizer (build_viz_payload in src-tauri/.../viz.rs)
  // rewrites the model's args into a canonical shape. Whatever IT emits must
  // pass THIS gate, or a card the backend rendered shows as "Visualization
  // unavailable" in the chat. Both bugs below shipped that way.
  it("accepts the backend's normalized shapes", () => {
    // Table: every column carries an EXPLICIT align — a plain string column
    // becomes {label, align: "left"} — and an absent style is null.
    const table = parseVizPayload("table", {
      title: "API latency",
      columns: [
        { align: "left", label: "Route" },
        { align: "right", label: "p95" },
        { align: "right", label: "Δ" },
      ],
      rows: [["/api/sessions", "120 ms", "-8%"]],
      style: null,
    });
    expect(table).not.toBeNull();
    expect(table?.kind === "table" && table.columns[0]).toEqual({ label: "Route", align: "left" });

    // Timeline: an event with no detail/at normalizes to the empty string.
    const timeline = parseVizPayload("timeline", {
      title: "API incident Oct 9",
      events: [
        { at: "14:02", detail: "p95 breached SLO", label: "Alert fired" },
        { at: "14:11", detail: "", label: "Mitigated" },
      ],
      style: null,
    });
    expect(timeline).not.toBeNull();
    expect(timeline?.kind === "timeline" && timeline.events[1]).toEqual({
      label: "Mitigated",
      detail: "",
      at: "14:11",
    });

    // Line: a point with no label normalizes to "".
    const line = parseVizPayload("line", {
      title: "p95 trend",
      area: true,
      points: [
        { label: "Mon", value: 120 },
        { label: "", value: 96 },
      ],
      style: null,
    });
    expect(line).not.toBeNull();
    expect(line?.kind === "line" && line.points[1]).toEqual({ label: "", value: 96 });
  });

  it("still rejects over-long optional strings", () => {
    expect(parseVizPayload("timeline", { events: [{ label: "e", detail: "x".repeat(301) }] })).toBeNull();
    expect(parseVizPayload("timeline", { events: [{ label: "e", at: "x".repeat(41) }] })).toBeNull();
    expect(parseVizPayload("line", { points: [{ label: "x".repeat(81), value: 1 }, { label: "b", value: 2 }] })).toBeNull();
    expect(parseVizPayload("table", { columns: [{ label: "a", align: "left" }, { label: "b", align: true }], rows: [["x", "y"]] })).toBeNull();
  });
});

describe("VizCard (renderer registry)", () => {
  afterEach(cleanup);

  it("renders the chart from data", () => {
    const { container, getByTestId } = render(<VizCard viz={CHART.viz} payload={CHART.payload} />);
    expect(getByTestId("viz-card-chart")).toBeTruthy();
    expect(getByTestId("viz-chart")).toBeTruthy();
    expect(container.textContent).toContain("Deploys by week");
    expect(container.textContent).toContain("15 deploys"); // max bar value + unit
    expect(container.querySelectorAll(".chat-viz-chart-bar").length).toBe(3);
    expect(container.textContent).toContain("W1");
  });

  it("renders the table with alignment", () => {
    const { getByTestId, container } = render(<VizCard viz={TABLE.viz} payload={TABLE.payload} />);
    expect(getByTestId("viz-table")).toBeTruthy();
    const ths = container.querySelectorAll("th");
    expect(ths.length).toBe(2);
    expect((ths[1] as HTMLElement).style.textAlign).toBe("right");
    expect(container.textContent).toContain("340 ms");
  });

  it("renders the board with per-column counts", () => {
    const { getByTestId, container } = render(<VizCard viz={BOARD.viz} payload={BOARD.payload} />);
    expect(getByTestId("viz-board")).toBeTruthy();
    expect(container.textContent).toContain("Sprint 42");
    expect(container.textContent).toContain("Design API");
    expect(container.textContent).toContain("2d");
    const counts = [...container.querySelectorAll(".chat-viz-board-count")].map((n) => n.textContent);
    expect(counts).toEqual(["2", "1"]);
  });

  it("renders the timeline with details and timestamps", () => {
    const { getByTestId, container } = render(<VizCard viz={TIMELINE.viz} payload={TIMELINE.payload} />);
    expect(getByTestId("viz-timeline")).toBeTruthy();
    expect(container.textContent).toContain("Alert fired");
    expect(container.textContent).toContain("14:02");
    expect(container.textContent).toContain("p95 breached SLO");
    expect(container.querySelectorAll(".chat-viz-event").length).toBe(2);
  });

  it("unescapes marker-sanitized strings back to the authored data", () => {
    // What JSON.parse of a backend-sanitized marker yields: the label rode
    // the marker as a<\\\/tool>b and must render as a</tool>b again.
    const escaped = { bars: [{ label: "a<\\/tool>b", value: 2 }] };
    const parsed = parseVizPayload("chart", escaped);
    expect(parsed?.kind === "chart" && parsed.bars[0].label).toBe("a</tool>b");
    const { container } = render(<VizCard viz="chart" payload={escaped} />);
    expect(container.textContent).toContain("a</tool>b");
  });

  it("falls back explicitly for unknown kinds and malformed payloads", () => {
    const first = render(<VizCard viz="map" payload={{ whatever: 1 }} />);
    expect(first.getByTestId("viz-fallback")).toBeTruthy();
    first.unmount();
    const bad = render(<VizCard viz="chart" payload={{ bars: [{ label: "", value: 1 }] }} />);
    expect(bad.getByTestId("viz-fallback")).toBeTruthy();
  });
});

describe("vizToCsv (card data export)", () => {
  it("flattens every kind", () => {
    const chart = parseVizPayload("chart", CHART.payload)!;
    expect(vizToCsv(chart)).toBe("label,value (deploys)\nW1,12\nW2,9\nW3,15");

    const table = parseVizPayload("table", TABLE.payload)!;
    expect(vizToCsv(table)).toBe("Route,p95\n/api/a,120\n/api/b,340 ms");

    const board = parseVizPayload("task-board", BOARD.payload)!;
    expect(vizToCsv(board)).toBe(
      "column,task,meta\nTodo,Design API,2d\nTodo,Write tests,\nDone,Spec review,",
    );

    const timeline = parseVizPayload("timeline", TIMELINE.payload)!;
    expect(vizToCsv(timeline)).toBe(
      "label,at,detail\nAlert fired,14:02,p95 breached SLO\nRolled back,14:19,",
    );
  });

  it("escapes RFC-4180-hostile fields", () => {
    const chart = parseVizPayload("chart", {
      bars: [
        { label: "a,b", value: 1 },
        { label: 'say "hi"', value: 2 },
      ],
    })!;
    const csv = vizToCsv(chart)!;
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"say ""hi"""');
  });
});

describe("VizCard chart geometry + actions", () => {
  afterEach(cleanup);

  it("renders negatives on a true zero baseline", () => {
    const { container } = render(
      <VizCard
        viz="chart"
        payload={{ bars: [{ label: "up", value: 10 }, { label: "down", value: -5 }] }}
      />,
    );
    const bars = container.querySelectorAll<HTMLDivElement>(".chat-viz-chart-bar");
    expect(bars.length).toBe(2);
    // Positive bar: outer edge at (max-10)/15 = 0% top, height 10/15.
    expect(bars[0]!.style.top).toBe("0%");
    expect(bars[0]!.style.height).toBe("66.66666666666666%");
    // Negative bar hangs BELOW the zero line: top at zero (10/15) …
    expect(bars[1]!.classList.contains("neg")).toBe(true);
    expect(bars[1]!.style.top).toBe("66.66666666666666%");
    // … and the zero line sits at max/range from the top.
    const zero = container.querySelector<HTMLDivElement>(".chat-viz-chart-zero")!;
    expect(zero.style.top).toBe("66.66666666666666%");
  });

  it("copies CSV and JSON through the app clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { container } = render(<VizCard viz={TABLE.viz} payload={TABLE.payload} />);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".chat-viz-action")];
    expect(buttons.length).toBe(2);
    fireEvent.click(buttons[0]!); // CSV
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain("Route,p95\n/api/a,120");
    fireEvent.click(buttons[1]!); // JSON
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    const json = JSON.parse(writeText.mock.calls[1]![0] as string);
    expect(json.kind).toBe("table");
  });

  it("renders the always-present title row with actions for untitled cards", () => {
    const { container } = render(
      <VizCard viz="chart" payload={{ bars: [{ label: "a", value: 1 }] }} />,
    );
    expect(container.querySelector(".chat-viz-title-text")?.textContent).toBe("Visualization");
    expect(container.querySelectorAll(".chat-viz-action").length).toBe(2);
  });
});

describe("new kinds: line, donut, stat", () => {
  const LINE = {
    viz: "line",
    payload: {
      title: "p95 trend", unit: "ms",
      points: [{ label: "Mon", value: 120 }, { label: "Tue", value: 96 }, { label: "Wed", value: 140 }],
    },
  };
  const DONUT = {
    viz: "donut",
    payload: {
      title: "Spend", unit: "%",
      segments: [{ label: "Compute", value: 60 }, { label: "Storage", value: 30 }, { label: "Net", value: 10 }],
    },
  };
  const STATS = {
    viz: "stat",
    payload: {
      title: "Today",
      stats: [{ label: "Deploys", value: "14", delta: "+3", good: true }, { label: "Errors", value: "0.4%" }],
    },
  };

  it("validates all three", () => {
    for (const t of [LINE, DONUT, STATS]) {
      expect(parseVizPayload(t.viz, t.payload), t.viz).not.toBeNull();
    }
  });

  it("rejects malformed line/donut/stat", () => {
    expect(parseVizPayload("line", { points: [{ value: 1 }] })).toBeNull(); // needs 2+
    expect(parseVizPayload("line", { points: [{ label: "a" }] })).toBeNull();
    expect(parseVizPayload("donut", { segments: [{ label: "a", value: -1 }] })).toBeNull();
    expect(parseVizPayload("donut", { segments: [{ label: "a", value: 0 }] })).toBeNull(); // zero total
    expect(parseVizPayload("stat", { stats: [{ label: "a" }] })).toBeNull(); // no value
    expect(parseVizPayload("stat", { stats: [{ label: "a", value: 12 }] })).toBeNull(); // number value
  });

  it("renders the line with points and an area fill", () => {
    const { getByTestId, container } = render(<VizCard viz={LINE.viz} payload={LINE.payload} />);
    expect(getByTestId("viz-line")).toBeTruthy();
    expect(container.querySelectorAll("circle").length).toBe(3);
    expect(container.querySelector("path[fill]") ?? container.querySelector("path")).toBeTruthy();
    expect(container.textContent).toContain("140");
  });

  it("renders the donut with a legend", () => {
    const { getByTestId, container } = render(<VizCard viz={DONUT.viz} payload={DONUT.payload} />);
    expect(getByTestId("viz-donut")).toBeTruthy();
    expect(container.querySelectorAll("circle[stroke]").length).toBe(3);
    expect(container.textContent).toContain("Compute");
    expect(container.textContent).toContain("60");
  });

  it("renders stat tiles with directional deltas", () => {
    const { getByTestId, container } = render(<VizCard viz={STATS.viz} payload={STATS.payload} />);
    expect(getByTestId("viz-stats")).toBeTruthy();
    expect(container.textContent).toContain("14");
    expect(container.querySelector(".chat-viz-stat-delta.good")).toBeTruthy();
    expect(container.querySelectorAll(".chat-viz-stat").length).toBe(2);
  });

  it("exports the new kinds to CSV", () => {
    const line = parseVizPayload("line", LINE.payload)!;
    expect(vizToCsv(line)).toBe(
      "label,value\nMon,120\nTue,96\nWed,140",
    );
    const donut = parseVizPayload("donut", DONUT.payload)!;
    expect(vizToCsv(donut)).toBe(
      "segment,value (%)\nCompute,60\nStorage,30\nNet,10",
    );
  });
});

describe("agent-chosen style", () => {
  afterEach(cleanup);

  it("applies accent + palette as scoped CSS custom properties", () => {
    const { container } = render(
      <VizCard
        viz="chart"
        payload={{
          title: "Art-directed",
          style: { accent: "#ff6b6b", tone: "dark", radius: "sharp", palette: ["#ff6b6b", "#4ecdc4"] },
          bars: [{ label: "a", value: 1 }],
        }}
      />,
    );
    const card = container.querySelector<HTMLElement>('[data-testid="viz-card-chart"]')!;
    expect(card.style.getPropertyValue("--viz-accent")).toBe("#ff6b6b");
    expect(card.style.getPropertyValue("--viz-c1")).toBe("#ff6b6b");
    expect(card.style.getPropertyValue("--viz-c2")).toBe("#4ecdc4");
    expect(card.style.getPropertyValue("--viz-radius")).toBe("2px");
    expect(card.className).toContain("chat-viz-tone-dark");
    // The bar picks up the palette color.
    const bar = container.querySelector<HTMLElement>(".chat-viz-chart-bar")!;
    expect(bar.style.background).toBe("rgb(255, 107, 107)");
  });

  it("renders tone-dark cards on a dark surface", () => {
    const { container } = render(
      <VizCard
        viz="stat"
        payload={{
          style: { tone: "dark", accent: "#88c0d0" },
          stats: [{ label: "Uptime", value: "99.98%" }],
        }}
      />,
    );
    const card = container.querySelector<HTMLElement>('[data-testid="viz-card-stat"]')!;
    expect(card.style.getPropertyValue("--viz-bg")).toBe("#181818");
    expect(card.className).toContain("chat-viz-tone-dark");
  });

  it("rejects hostile style values (CSS injection attempt)", () => {
    for (const bad of ["url(javascript:alert(1))", "var(--x)", "red; } body { background: red", "auto"]) {
      expect(
        parseVizPayload("chart", {
          style: { accent: bad },
          bars: [{ label: "a", value: 1 }],
        }),
        bad,
      ).toBeNull();
    }
    // A too-long palette is rejected outright.
    expect(
      parseVizPayload("chart", {
        style: { palette: Array.from({ length: 9 }, (_, i) => `#ffffff0${i}`) },
        bars: [{ label: "a", value: 1 }],
      }),
    ).toBeNull();
  });

  it("keeps everything theme-native when no style is given", () => {
    const { container } = render(<VizCard viz={TABLE.viz} payload={TABLE.payload} />);
    const card = container.querySelector<HTMLElement>('[data-testid="viz-card-table"]')!;
    expect(card.style.getPropertyValue("--viz-accent")).toBe("");
    expect(card.className).not.toContain("chat-viz-tone");
  });

  it("renders style on every kind through the payload union", () => {
    const payloads: VizPayload[] = [];
    for (const kind of ["chart", "table", "task-board", "timeline", "line", "donut", "stat"] as const) {
      const p = parseVizPayload(
        kind,
        kind === "chart" ? { style: { accent: "#123456" }, bars: [{ label: "a", value: 1 }] }
        : kind === "table" ? { style: { tone: "dark" }, columns: ["a"], rows: [["x"]] }
        : kind === "task-board" ? { style: { radius: "pill" }, columns: [{ title: "c", tasks: [] }] }
        : kind === "timeline" ? { style: { accent: "#123456" }, events: [{ label: "e" }] }
        : kind === "line" ? { style: { accent: "#123456" }, points: [{ value: 1 }, { value: 2 }] }
        : kind === "donut" ? { style: { accent: "#123456" }, segments: [{ label: "a", value: 1 }] }
        : { style: { tone: "light" }, stats: [{ label: "a", value: "1" }] },
      );
      expect(p, kind).not.toBeNull();
      payloads.push(p!);
    }
    expect(payloads.every((p) => p.style !== null)).toBe(true);
  });
});

describe("groupSegments routes viz-data markers (placement)", () => {
  const marker = (data: object, done: boolean) =>
    parseSegments(`<tool>${JSON.stringify(data)}</tool>`).map((s) => (s.type === "tool" ? { ...s, done } : s));

  it("a completed viz-data marker becomes its own viz block", () => {
    const segs = marker(
      { kind: "viz-data", title: "Deploys", viz: "chart", payload: CHART.payload },
      true,
    );
    const blocks = groupSegments(segs as never);
    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe("viz");
    if (blocks[0].kind === "viz") {
      expect(blocks[0].step.data?.viz).toBe("chart");
    }
  });

  it("a streaming (unclosed) viz marker stays a live step row, not a card", () => {
    const segs = marker(
      { kind: "viz-data", title: "Visualizing", viz: "chart", payload: CHART.payload },
      false,
    );
    const blocks = groupSegments(segs as never);
    expect(blocks.some((b) => b.kind === "activity")).toBe(true);
    expect(blocks.some((b) => b.kind === "viz")).toBe(false);
  });

  it("a viz followed by narration keeps the viz as the answer-area block and prose outside", () => {
    const content = `<tool>${JSON.stringify({
      kind: "viz-data",
      title: "Deploys",
      viz: "chart",
      payload: CHART.payload,
    })}</tool>Here is the chart — the W3 spike is the release train.`;
    const blocks = groupSegments(parseSegments(content));
    expect(blocks.length).toBe(2);
    expect(blocks[0].kind).toBe("viz");
    expect(blocks[1].kind).toBe("text");
  });

  it("a viz between tool calls never joins the folded activity run", () => {
    const content =
      `<tool>${JSON.stringify({ kind: "search", title: "Searching the web", detail: "q" })}</tool>` +
      `<tool>${JSON.stringify({ kind: "viz-data", title: "T", viz: "table", payload: TABLE.payload })}</tool>` +
      `<tool>${JSON.stringify({ kind: "search", title: "Searching the web", detail: "q2" })}</tool>`;
    const blocks = groupSegments(parseSegments(content));
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toEqual(["activity", "viz", "activity"]);
  });
});

// End-to-end regression: these are the SEVEN markers the backend actually
// emitted for a live "one card per kind" turn (payloads copied verbatim from
// the persisted transcript). Cards 4 and 6 came back "Visualization
// unavailable" because the frontend gate rejected the normalized shapes its
// own backend produces; every kind must render from these exact bytes.
describe("all seven backend-normalized markers render", () => {  const MARKERS = [
    '<tool>{"detail":"Deploys by week","kind":"viz-data","payload":{"bars":[{"label":"W1","value":4},{"label":"W2","value":9},{"label":"W3","value":7},{"label":"W4","value":12},{"label":"W5","value":5},{"label":"W6","value":14}],"kind":"chart","style":{"accent":"#e07a5f","palette":null,"radius":null,"tone":null},"title":"Deploys by week","unit":"deploys"},"title":"Visualizing","viz":"chart"}</tool>',
    '<tool>{"detail":"p95 trend","kind":"viz-data","payload":{"area":true,"kind":"line","points":[{"label":"Mon","value":120},{"label":"Tue","value":96},{"label":"Wed","value":140},{"label":"Thu","value":88},{"label":"Fri","value":102}],"style":null,"title":"p95 trend","unit":"ms"},"title":"Visualizing","viz":"line"}</tool>',
    '<tool>{"detail":"Spend by team","kind":"viz-data","payload":{"kind":"donut","segments":[{"label":"Compute","value":45.0},{"label":"Storage","value":30.0},{"label":"Network","value":15.0},{"label":"Other","value":10.0}],"style":{"accent":null,"palette":["#e07a5f","#3d5a80","#81b29a","#f2cc8f"],"radius":null,"tone":"dark"},"title":"Spend by team","total":100.0,"unit":"$k"},"title":"Visualizing","viz":"donut"}</tool>',
    '<tool>{"detail":"API latency","kind":"viz-data","payload":{"columns":[{"align":"left","label":"Route"},{"align":"right","label":"p95"},{"align":"right","label":"Δ"}],"kind":"table","rows":[["/api/sessions","120 ms","-8%"],["/api/viz/validate","340 ms","+3%"],["/api/artifacts","86 ms","-21%"]],"style":null,"title":"API latency"},"title":"Visualizing","viz":"table"}</tool>',
    '<tool>{"detail":"Sprint 42","kind":"viz-data","payload":{"columns":[{"tasks":[{"meta":"security","title":"Harden sandbox CSP"},{"title":"Polish timeline"}],"title":"Todo"},{"tasks":[{"meta":"@mara","title":"Renderer registry routing"}],"title":"In progress"},{"tasks":[{"title":"Chart renderer"},{"title":"Marker sanitization"}],"title":"Done"}],"kind":"task-board","style":null,"title":"Sprint 42"},"title":"Visualizing","viz":"task-board"}</tool>',
    '<tool>{"detail":"API incident Oct 9","kind":"viz-data","payload":{"events":[{"at":"14:02","detail":"p95 breached SLO","label":"Alert fired"},{"at":"14:11","detail":"","label":"Mitigated by shedding batch jobs"},{"at":"14:19","detail":"p95 recovered in 2 min","label":"Rolled back to previous pin"}],"kind":"timeline","style":null,"title":"API incident Oct 9"},"title":"Visualizing","viz":"timeline"}</tool>',
    '<tool>{"detail":"This week","kind":"viz-data","payload":{"kind":"stat","stats":[{"delta":"+3","good":true,"label":"Deploys","value":"14"},{"delta":"-0.1%","good":true,"label":"Error rate","value":"0.4%"},{"delta":null,"good":null,"label":"Uptime","value":"99.98%"}],"style":{"accent":"#3d5a80","palette":null,"radius":null,"tone":"light"},"title":"This week"},"title":"Visualizing","viz":"stat"}</tool>',
  ];

  it("renders every kind and hoists none into the folded process region", () => {
    const content = MARKERS.join("");
    const blocks = groupSegments(parseSegments(content));
    expect(blocks.map((b) => b.kind)).toEqual([
      "viz", "viz", "viz", "viz", "viz", "viz", "viz",
    ]);
    for (const b of blocks) {
      if (b.kind !== "viz") continue;
      const { getByTestId, container } = render(
        <VizCard viz={b.step.data?.viz} payload={b.step.data?.payload} />,
      );
      expect(container.querySelector('[data-testid^="viz-card-"]'), b.step.data?.viz).toBeTruthy();
      expect(container.querySelector('[data-testid="viz-fallback"]')).toBeNull();
      expect(getByTestId(`viz-card-${b.step.data?.viz}`)).toBeTruthy();
      cleanup();
    }
  });
});
