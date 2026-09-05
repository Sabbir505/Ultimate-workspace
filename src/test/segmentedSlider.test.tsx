// SegmentedSlider (the codex-style pill slider used for reasoning effort and
// Auto bias): accent fill + white knob glide between dot-marked stops, labels
// align under the stops, arrow keys move between stops, role="slider" a11y.
import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SegmentedSlider } from "../components/chat/SegmentedSlider";

afterEach(cleanup);

const OPTIONS = [
  { value: "quality", label: "Quality", title: "t-q" },
  { value: "balanced", label: "Balanced", title: "t-b" },
  { value: "economy", label: "Economy", title: "t-e" },
] as const;

function renderSlider(override: Partial<Parameters<typeof SegmentedSlider>[0]> = {}) {
  const onChange = vi.fn();
  const view = render(
    <SegmentedSlider
      ariaLabel="bias"
      options={OPTIONS}
      value="balanced"
      onChange={onChange}
      {...override}
    />,
  );
  const rail = screen.getByRole("slider", { name: "bias" });
  return { onChange, rail, container: view.container };
}

describe("SegmentedSlider", () => {
  it("exposes slider semantics with the active stop as valuetext", () => {
    const { rail } = renderSlider();
    expect(rail.getAttribute("aria-valuenow")).toBe("1");
    expect(rail.getAttribute("aria-valuetext")).toBe("Balanced");
    expect(rail.getAttribute("aria-valuemax")).toBe("2");
  });

  it("positions the knob at the active stop with knob-radius insets", () => {
    const { container, rerender } = render(<SegmentedSlider ariaLabel="bias" options={OPTIONS} value="quality" onChange={() => {}} />);
    const knob = container.querySelector<HTMLElement>(".seg-slider-knob")!;
    // First stop: knob center sits at the 13px inset (knob half + border).
    expect(knob.style.left).toBe("calc(13px + 0 * (100% - 26px))");
    expect(container.querySelector<HTMLElement>(".seg-slider")!.classList.contains("max")).toBe(
      false
    );
    rerender(
      <SegmentedSlider ariaLabel="bias" options={OPTIONS} value="economy" onChange={() => {}} />,
    );
    expect(knob.style.left).toBe("calc(13px + 1 * (100% - 26px))");
    // The fill tracks the same travel and every stop gets a dot mark.
    expect(container.querySelector<HTMLElement>(".seg-slider-fill")!.style.width).toBe(
      "calc(13px + 1 * (100% - 26px))",
    );
    expect(container.querySelectorAll(".seg-slider-dot")).toHaveLength(3);
    // Labels align under their stops — edge labels clamp so they don't
    // half-overflow the pane (first left-aligned, last right-aligned).
    const labels = [...container.querySelectorAll<HTMLElement>(".seg-slider-label")];
    expect(labels.map((l) => l.textContent)).toEqual(["Quality", "Balanced", "Economy"]);
    expect(labels[2]!.classList.contains("selected")).toBe(true);
    expect(labels[0]!.style.transform).toBe("translateX(0)");
    expect(labels[1]!.style.transform).toBe("translateX(-50%)");
    expect(labels[2]!.style.transform).toBe("translateX(-100%)");
  });

  it("arrow keys move between stops and report the value", () => {
    const { onChange, rail } = renderSlider();
    fireEvent.keyDown(rail, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("economy");
    fireEvent.keyDown(rail, { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("quality");
    // The active stop is the end — further movement CLAMPS there. (In this
    // controlled-component test the mock never updates `value`, so the
    // unchanged-value dedupe inside setIndex can't suppress the clamped
    // call — it still reports "economy".)
    fireEvent.keyDown(rail, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("economy");
    fireEvent.keyDown(rail, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("economy");
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("an unknown value falls back to the first stop instead of rendering off-track", () => {
    const { container } = render(
      <SegmentedSlider ariaLabel="effort" options={OPTIONS} value={"bogus" as never} onChange={() => {}} />,
    );
    expect(container.querySelector<HTMLElement>(".seg-slider-knob")!.style.left).toBe(
      "calc(13px + 0 * (100% - 26px))",
    );
  });
});
