// Prompt template library (roadmap #14) — the shared variable helpers in
// ipc.ts (templateVariables + fillTemplate) and the PromptTemplatesPanel
// (add/edit/remove, variable detection).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  templateVariables,
  fillTemplate,
} from "../lib/ipc";
import { PromptTemplatesPanel } from "../components/settings/PromptTemplatesPanel";

const listPromptTemplatesMock = vi.fn();
const savePromptTemplatesMock = vi.fn();

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    listPromptTemplates: (...a: unknown[]) => listPromptTemplatesMock(...a),
    savePromptTemplates: (...a: unknown[]) => savePromptTemplatesMock(...a),
  };
});

describe("template variable helpers", () => {
  it("extracts unique variables in order", () => {
    expect(templateVariables("write a {{type}} review of {{code}} and a {{type}} summary"))
      .toEqual(["type", "code"]);
    expect(templateVariables("no placeholders here")).toEqual([]);
  });

  it("fills variables and blanks missing ones", () => {
    expect(fillTemplate("{{a}} + {{b}} = {{c}}", { a: "1", b: "2" })).toBe("1 + 2 = ");
  });

  it("handles whitespace inside braces", () => {
    expect(templateVariables("use {{ thing }} here")).toEqual(["thing"]);
    expect(fillTemplate("hi {{x }}", { x: "X" })).toBe("hi X");
  });
});

describe("PromptTemplatesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listPromptTemplatesMock.mockResolvedValue([]);
    savePromptTemplatesMock.mockResolvedValue(undefined);
  });
  afterEach(cleanup);

  it("lists persisted templates", async () => {
    listPromptTemplatesMock.mockResolvedValue([
      { id: "t1", name: "Code review", trigger: "review", body: "Review {{code}} please", createdAt: 1 },
    ]);
    render(<PromptTemplatesPanel />);
    expect(await screen.findByText(/Code review/)).toBeTruthy();
    // `{{code}}` appears in both the body preview and the vars badge.
    expect(screen.getAllByText(/\{\{code\}\}/).length).toBeGreaterThan(0);
  });

  it("adds a template and persists it", async () => {
    listPromptTemplatesMock.mockResolvedValue([]);
    render(<PromptTemplatesPanel />);
    fireEvent.change(screen.getByPlaceholderText("Template name"), { target: { value: "Summarize" } });
    fireEvent.change(screen.getByPlaceholderText(/Prompt body/), { target: { value: "Summarize {{topic}} in 3 bullets" } });
    fireEvent.click(screen.getByText("Add template"));
    await waitFor(() => expect(savePromptTemplatesMock).toHaveBeenCalled());
    const saved = savePromptTemplatesMock.mock.calls[0][0];
    expect(saved[0].name).toBe("Summarize");
    expect(saved[0].body).toContain("{{topic}}");
  });

  it("validates required fields", async () => {
    listPromptTemplatesMock.mockResolvedValue([]);
    render(<PromptTemplatesPanel />);
    fireEvent.click(screen.getByText("Add template"));
    await waitFor(() => expect(screen.getByText(/Name and prompt body are required/)).toBeTruthy());
    expect(savePromptTemplatesMock).not.toHaveBeenCalled();
  });

  it("removes a template", async () => {
    listPromptTemplatesMock.mockResolvedValue([
      { id: "t1", name: "Boom", trigger: "", body: "no vars", createdAt: 1 },
    ]);
    render(<PromptTemplatesPanel />);
    fireEvent.click(await screen.findByText("Remove"));
    await waitFor(() => expect(savePromptTemplatesMock).toHaveBeenCalled());
    expect(savePromptTemplatesMock.mock.calls[0][0]).toHaveLength(0);
  });
});
