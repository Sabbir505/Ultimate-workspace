// Artifact type selector for the /create slash command.
// Shows a dropdown with the four artifact types when user types "/create"
import { useEffect, useRef, useState } from "react";

type ArtifactType = "skill" | "loop" | "prompt_template" | "automation";

interface ArtifactTypeSelectorProps {
  /** Called when user selects a type. */
  onSelect: (type: ArtifactType, instruction?: string) => void;
  /** Called when user cancels/closes the selector. */
  onClose: () => void;
  /** Initial instruction text (from "/create type instruction"). */
  initialInstruction?: string;
}

const TYPES: { type: ArtifactType; label: string; description: string; icon: string }[] = [
  {
    type: "skill",
    label: "Reusable Skill",
    description: "A general-purpose skill with inputs, instructions, and optional tools",
    icon: "⚙",
  },
  {
    type: "loop",
    label: "Goal Loop",
    description: "An iterative workflow that runs until a stop condition is met",
    icon: "🔄",
  },
  {
    type: "prompt_template",
    label: "Prompt Template",
    description: "A reusable prompt template with variables for consistent outputs",
    icon: "📝",
  },
  {
    type: "automation",
    label: "Automation",
    description: "A scheduled or event-triggered workflow that runs automatically",
    icon: "⏰",
  },
];

export function ArtifactTypeSelector({
  onSelect,
  onClose,
  initialInstruction = "",
}: ArtifactTypeSelectorProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [instruction, setInstruction] = useState(initialInstruction);
  const [showInstruction, setShowInstruction] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the container for keyboard navigation
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % TYPES.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + TYPES.length) % TYPES.length);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const type = TYPES[selectedIndex].type;
        onSelect(type, instruction.trim() || undefined);
        return;
      }
      if (e.key === "Tab" && !showInstruction) {
        e.preventDefault();
        setShowInstruction(true);
        // Focus the instruction input
        setTimeout(() => inputRef.current?.focus(), 0);
        return;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedIndex, instruction, showInstruction, onSelect, onClose]);

  const handleOptionClick = (type: ArtifactType) => {
    onSelect(type, instruction.trim() || undefined);
  };

  const handleInstructionChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInstruction(e.target.value);
  };

  const handleInstructionKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const type = TYPES[selectedIndex].type;
      onSelect(type, instruction.trim() || undefined);
    } else if (e.key === "Escape") {
      setShowInstruction(false);
      setInstruction(initialInstruction);
    }
  };

  return (
    <>
      {/* Scrim dims/blurs the app behind the sheet; any click closes. */}
      <div className="artifact-type-scrim" onMouseDown={onClose} aria-hidden="true" />
      <div
        ref={containerRef}
        className="artifact-type-selector"
        tabIndex={-1}
        role="dialog"
        aria-label="Select artifact type"
      >
        <div className="artifact-type-selector-header">
          <span className="artifact-type-selector-title">Create Artifact</span>
          <span className="artifact-type-selector-hint">↑↓ navigate · Enter select · Esc cancel</span>
        </div>

        <div className="artifact-type-selector-options" role="listbox" aria-label="Artifact types">
          {TYPES.map((item, index) => (
            <button
              key={item.type}
              data-type={item.type}
              role="option"
              aria-selected={index === selectedIndex}
              className={`artifact-type-option ${index === selectedIndex ? "selected" : ""}`}
              onClick={() => handleOptionClick(item.type)}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <span className="artifact-type-icon">{item.icon}</span>
              <div className="artifact-type-info">
                <div className="artifact-type-label">{item.label}</div>
                <div className="artifact-type-description">{item.description}</div>
              </div>
            </button>
          ))}
        </div>

      {showInstruction && (
        <div className="artifact-type-instruction">
          <input
            ref={inputRef}
            type="text"
            value={instruction}
            onChange={handleInstructionChange}
            onKeyDown={handleInstructionKeyDown}
            placeholder="Additional instruction (optional)"
            className="artifact-type-instruction-input"
          />
          <div className="artifact-type-instruction-hint">
            Press Enter to create, Esc to go back
          </div>
        </div>
      )}

      {!showInstruction && (
        <div className="artifact-type-selector-footer">
          Press <kbd>Tab</kbd> to add instruction
        </div>
      )}
      </div>
    </>
  );
}