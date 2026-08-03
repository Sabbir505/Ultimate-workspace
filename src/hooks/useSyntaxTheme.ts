// Hook that returns the current syntax-highlighting theme object, re-deriving
// it whenever the app's data-theme attribute changes. Consumers (the syntax
// highlighter components) pass this object as the `style` prop.
//
// Implementation: a MutationObserver on <html> attributes catches the
// data-theme toggle that useTheme applies; the hook recomputes the syntax
// style object from CSS custom properties each time.
import { useEffect, useState } from "react";
import { getSyntaxTheme } from "../lib/syntaxTheme";

export function useSyntaxTheme() {
  const [style, setStyle] = useState(getSyntaxTheme);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const recompute = () => setStyle(getSyntaxTheme());
    recompute();
    const obs = new MutationObserver(recompute);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  return style;
}
