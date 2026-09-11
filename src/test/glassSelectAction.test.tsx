// The dropdown's per-row action slot (used for voice auditioning).
//
// The thing that needs pinning is the separation of concerns: the row selects,
// the action does its own thing. An action click that also selected — or that
// closed the list — would make "click down the list and listen" impossible.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GlassSelect, type SelectOption } from "../components/common/GlassSelect";

const OPTIONS: SelectOption<string>[] = [
  { value: "af_heart", label: "af_heart", hint: "en-US" },
  { value: "bf_alice", label: "bf_alice", hint: "en-GB" },
];

function setup() {
  const onChange = vi.fn();
  const onPreview = vi.fn();
  render(
    <GlassSelect
      value="af_heart"
      options={OPTIONS}
      onChange={onChange}
      optionAction={(o) => (
        <button type="button" aria-label={`Preview ${o.value}`} onClick={() => onPreview(o.value)}>
          play
        </button>
      )}
    />,
  );
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  return { onChange, onPreview };
}

describe("GlassSelect option actions", () => {
  it("runs the row action without selecting the row", () => {
    const { onChange, onPreview } = setup();

    fireEvent.click(screen.getByLabelText("Preview bf_alice"));

    expect(onPreview).toHaveBeenCalledWith("bf_alice");
    // Not selected, and the list is still open so the next voice can be tried.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Preview af_heart")).toBeTruthy();
  });

  it("still selects when the row itself is clicked", () => {
    const { onChange, onPreview } = setup();

    fireEvent.click(screen.getByRole("option", { name: /bf_alice/ }));

    expect(onChange).toHaveBeenCalledWith("bf_alice");
    expect(onPreview).not.toHaveBeenCalled();
  });
});
