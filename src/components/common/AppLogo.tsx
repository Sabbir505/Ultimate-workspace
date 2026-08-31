// Relay app logo — the REAL brand asset (src-tauri/icons/128x128@2x.png,
// copied to public/logo.png), not a drawn approximation. An earlier inline
// SVG here tried to recreate the mark and drifted from the shipped icon
// (wrong chip proportions, missing rail glyphs). Used where the brand stands
// in for UI chrome (e.g. the collapsed-sidebar restore button).
//
// The image lives in public/ so the boot splash (index.html) can reference
// the same file by URL without bundling it twice. `/logo.png` is safe: the
// app builds with vite's default base ('/') under the Tauri protocol.
export function AppLogo({ size = 20 }: { size?: number }) {
  return (
    <img
      src="/logo.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        // The asset is a rounded-square tile; rounding the <img> as well
        // keeps the silhouette if a future source ships square corners.
        borderRadius: Math.max(2, size * 0.22),
        display: "block",
      }}
    />
  );
}
