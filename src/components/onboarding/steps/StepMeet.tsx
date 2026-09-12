// Step 1 — Meet Relay. Pure intro from the approved mock: title, the agent
// tile row with the real brand glyphs (same simple-icons paths as
// chat/agentIcons.tsx), and the 3D cube hero (pure CSS 3D, GPU-friendly
// transform animation). Nothing interactive except the footer's Get Started.
import { ClaudeIcon, KimiIcon, OpenCodeIcon, PiIcon } from "../../chat/agentIcons";

export function StepMeet() {
  return (
    <>
      <h1 className="onboarding-intro-title onb-rise">
        Meet <span className="onboarding-accent">Relay</span>
      </h1>
      <p className="onboarding-intro-sub onb-rise">
        One workspace for the AI agents
        <br />
        you already use.
      </p>

      <div className="onboarding-tile-row onb-rise">
        <div className="onboarding-tile t-claude">
          <span className="onboarding-tile-glyph">
            <ClaudeIcon />
          </span>
          <span>Claude Code</span>
        </div>
        <div className="onboarding-tile t-kimi">
          <span className="onboarding-tile-glyph">
            <KimiIcon />
          </span>
          <span>Kimi Code</span>
        </div>
        <div className="onboarding-tile t-opencode">
          <span className="onboarding-tile-glyph">
            <OpenCodeIcon />
          </span>
          <span>OpenCode</span>
        </div>
        <div className="onboarding-tile t-pi">
          <span className="onboarding-tile-glyph">
            <PiIcon />
          </span>
          <span>Pi</span>
        </div>
        <div className="onboarding-tile t-more">
          <span className="onboarding-tile-plus">+</span>
          <span>more</span>
        </div>
      </div>

      <div className="onboarding-hero-row onb-rise" aria-hidden="true">
        <div className="onboarding-scene">
          <div className="onboarding-cube-glow" />
          <div className="onboarding-orbit-ellipse" />
          <span className="onboarding-orbit-dot" style={{ left: "calc(24% - 186px)", top: "62%" }} />
          <span className="onboarding-orbit-dot" style={{ left: "calc(24% + 183px)", top: "59%" }} />
          <span className="onboarding-orbit-dot" style={{ left: "calc(24% + 88px)", top: "calc(62% + 53px)" }} />
          <div className="onboarding-cube-wrap">
            <div className="onboarding-cube">
              <i className="f back" />
              <i className="f left" />
              <i className="f right" />
              <i className="f bottom" />
              <i className="f top" />
              <i className="f front" />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
