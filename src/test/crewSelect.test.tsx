// CrewSelect — the crew surfaces' styled dropdown (button + portaled glass
// menu). Covers the interaction contract: opens anchored to the button,
// picks call onChange and close, Escape closes, and — the regression this
// file pins — the menu RE-ANCHORS when the button moves under it (the
// editor modal's own body scrolls; the menu is fixed-positioned, so without
// the capture-phase scroll listener it floated at the old spot).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { CrewSelect } from "../components/crew/CrewSelect";

const OPTIONS = [
  { value: "builtin", label: "Built-in loop" },
  { value: "harness:claude_code", label: "Claude Code" },
];

const rectAt = (top: number) =>
  ({
    top,
    bottom: top + 32,
    left: 50,
    right: 170,
    width: 120,
    height: 32,
    x: 50,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("CrewSelect", () => {
  it("shows the selected option's label and opens an accessible menu", () => {
    const { container } = render(
      <CrewSelect value="builtin" options={OPTIONS} onChange={() => {}} ariaLabel="Engine" />,
    );
    const btn = container.querySelector("button")!;
    expect(btn.textContent).toContain("Built-in loop");
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(btn);
    const menu = document.querySelector(".crew-select-menu")!;
    expect(menu).toBeTruthy();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(menu.getAttribute("role")).toBe("listbox");
    expect(menu.querySelectorAll(".crew-select-option").length).toBe(2);
  });

  it("selecting an option calls onChange once and closes the menu", () => {
    const onChange = vi.fn();
    const { container } = render(
      <CrewSelect value="" options={OPTIONS} onChange={onChange} ariaLabel="Engine" />,
    );
    fireEvent.click(container.querySelector("button")!);
    const option = [...document.querySelectorAll(".crew-select-option")].find((b) =>
      b.textContent?.includes("Claude Code"),
    )!;
    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith("harness:claude_code");
    expect(document.querySelector(".crew-select-menu")).toBeNull();
  });

  it("closes on Escape", () => {
    const { container } = render(
      <CrewSelect value="" options={OPTIONS} onChange={() => {}} ariaLabel="Engine" />,
    );
    fireEvent.click(container.querySelector("button")!);
    expect(document.querySelector(".crew-select-menu")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".crew-select-menu")).toBeNull();
  });

  it("re-anchors the open menu when the button moves (scroll/resize)", () => {
    const { container } = render(
      <CrewSelect value="" options={OPTIONS} onChange={() => {}} ariaLabel="Engine" />,
    );
    const btn = container.querySelector("button") as HTMLButtonElement;
    // jsdom rects are all-zero; pin a movable one so the anchor is real.
    let top = 100;
    btn.getBoundingClientRect = () => rectAt(top);

    fireEvent.click(btn);
    let menu = document.querySelector(".crew-select-menu") as HTMLElement;
    // Drops 4px below the button (100 + 32 + 4).
    expect(menu.style.top).toBe("136px");

    // The modal body scrolls: the button moves down, and the fixed-position
    // menu must follow instead of floating where the button used to be.
    top = 260;
    fireEvent.scroll(window);
    menu = document.querySelector(".crew-select-menu") as HTMLElement;
    // 260 + 32 + 4.
    expect(menu.style.top).toBe("296px");

    // Window resize re-anchors too.
    top = 40;
    fireEvent.resize(window);
    menu = document.querySelector(".crew-select-menu") as HTMLElement;
    // 40 + 32 + 4.
    expect(menu.style.top).toBe("76px");
  });

  it("cleans its listeners up when the menu closes", () => {
    const { container } = render(
      <CrewSelect value="" options={OPTIONS} onChange={() => {}} ariaLabel="Engine" />,
    );
    const btn = container.querySelector("button") as HTMLButtonElement;
    let top = 100;
    btn.getBoundingClientRect = () => rectAt(top);

    fireEvent.click(btn);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.querySelector(".crew-select-menu")).toBeNull();

    // After close, a scroll must not resurrect or move anything.
    top = 400;
    fireEvent.scroll(window);
    expect(document.querySelector(".crew-select-menu")).toBeNull();
  });
});
