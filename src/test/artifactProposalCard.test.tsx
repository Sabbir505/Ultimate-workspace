import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  parseCreateCommand,
  isBareCreateCommand,
} from "../components/chat/ChatComposer";
import { ArtifactProposalCard } from "../components/chat/ArtifactProposalCard";

describe("parseCreateCommand", () => {
  it("parses /create skill MySkill", () => {
    expect(parseCreateCommand("/create skill MySkill")).toEqual({
      type: "skill",
      instruction: "MySkill",
    });
  });

  it("parses /create-artifact automation daily sync", () => {
    expect(parseCreateCommand("/create-artifact automation daily sync")).toEqual({
      type: "automation",
      instruction: "daily sync",
    });
  });

  it("parses /create a loop ProcessData", () => {
    expect(parseCreateCommand("/create a loop ProcessData")).toEqual({
      type: "loop",
      instruction: "ProcessData",
    });
  });

  it("parses /create prompt_template my_template", () => {
    expect(parseCreateCommand("/create prompt_template my_template")).toEqual({
      type: "prompt_template",
      instruction: "my_template",
    });
  });

  it("parses /create prompt-template my_template", () => {
    expect(parseCreateCommand("/create prompt-template my_template")).toEqual({
      type: "prompt_template",
      instruction: "my_template",
    });
  });

  it("returns null for non-create commands", () => {
    expect(parseCreateCommand("hello world")).toBeNull();
    expect(parseCreateCommand("/goal loop")).toBeNull();
    expect(parseCreateCommand("/create invalid_type")).toBeNull();
  });

  it("returns empty instruction when no text provided after type", () => {
    expect(parseCreateCommand("/create skill")).toEqual({
      type: "skill",
      instruction: "",
    });
  });
});

describe("isBareCreateCommand", () => {
  it("recognises bare /create", () => {
    expect(isBareCreateCommand("/create")).toBe(true);
  });

  it("recognises /create artifact", () => {
    expect(isBareCreateCommand("/create artifact")).toBe(true);
  });

  it("recognises common typo /create artifect", () => {
    expect(isBareCreateCommand("/create artifect")).toBe(true);
  });

  it("rejects commands that already have a subtype", () => {
    expect(isBareCreateCommand("/create skill foo")).toBe(false);
    expect(isBareCreateCommand("/create-artifact")).toBe(true);
    expect(isBareCreateCommand("hello")).toBe(false);
  });
});

describe("ArtifactProposalCard", () => {
  const baseProposal = {
    id: "proposal-1",
    artifactType: "skill" as const,
    spec: {
      type: "skill" as const,
      name: "Test Skill",
      description: "A test skill",
      instructions: "Do the thing",
      inputs: [],
      outputs: [],
    },
    confidence: 0.9,
    missingFields: [] as string[],
    assumptions: [] as string[],
  };

  it("renders missing fields section and opens the form on click", () => {
    const proposal = {
      ...baseProposal,
      missingFields: ["spec.name is required"],
    };
    const onSubmit = vi.fn();

    render(
      <ArtifactProposalCard
        proposalId="wrap-1"
        proposal={proposal}
        state="ready"
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onDismiss={vi.fn()}
        onSubmitMissingFields={onSubmit}
      />,
    );

    expect(screen.getByText(/Missing fields:/)).toBeTruthy();
    const fillBtn = screen.getByRole("button", { name: /Fill missing fields/i });
    expect(fillBtn).toBeTruthy();
  });

  it("shows the regenerating spinner while generating", () => {
    render(
      <ArtifactProposalCard
        proposalId="wrap-2"
        proposal={baseProposal}
        state="generating"
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/Regenerating artifact/i)).toBeTruthy();
  });

  it("renders Edit / Create / Regenerate / Dismiss buttons when ready", () => {
    render(
      <ArtifactProposalCard
        proposalId="wrap-3"
        proposal={baseProposal}
        state="ready"
        onCreate={vi.fn()}
        onEdit={vi.fn()}
        onRegenerate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Create/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });
});
