// Dev-only driver for vault-rail-harness.html: mirrors VaultView's inline
// style switching (width / min-width / maxWidth) plus the collapsed class, so
// the real vault.css animation can be measured without the Tauri backend.
import "../styles/global.css";

const RAIL_W = 250;
const COLLAPSED_W = 28;

const rail = document.getElementById("rail")!;
const inner = document.getElementById("inner")!;
const readout = document.getElementById("readout")!;
let collapsed = false;

function apply() {
  rail.style.width = collapsed ? `${COLLAPSED_W}px` : `${RAIL_W}px`;
  rail.style.minWidth = collapsed ? `${COLLAPSED_W}px` : `${RAIL_W}px`;
  rail.style.maxWidth = "400px";
  rail.classList.toggle("collapsed", collapsed);
  // VaultView keeps the inner at the EXPANDED pixel width (inline) so the
  // content never reflows mid-slide; the rail's overflow: hidden clips it.
  inner.style.width = `${RAIL_W}px`;
  readout.textContent = collapsed ? "collapsed — click ⌐ to expand" : "expanded — click ⌐ to collapse";
}

(window as unknown as Record<string, unknown>).__harness = {
  toggle: () => {
    collapsed = !collapsed;
    apply();
    return collapsed ? "collapsed" : "expanded";
  },
  // Sample the animated width over time; snap-free if it moves gradually.
  measure: () => {
    const samples: string[] = [];
    const t0 = performance.now();
    return new Promise<string>((resolve) => {
      const iv = window.setInterval(() => {
        samples.push(`${((performance.now() - t0) / 1000).toFixed(2)}s:${rail.getBoundingClientRect().width.toFixed(0)}px`);
        readout.textContent = samples.join("  ");
        if (performance.now() - t0 > 420) {
          window.clearInterval(iv);
          resolve(samples.join("  "));
        }
      }, 60);
    });
  },
};

document.getElementById("collapseBtn")!.addEventListener("click", () => (window as any).__harness.toggle());
document.getElementById("expandBtn")!.addEventListener("click", () => (window as any).__harness.toggle());
apply();
