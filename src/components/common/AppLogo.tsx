// Relay app logo — the REAL brand asset (src-tauri/icons/final.png, made
// transparent and published as public/logo.png by
// scripts/make_logo_transparent.py). The PNG carries its own rounded-square
// silhouette with transparent corners, so no CSS rounding is applied — the
// artwork's exact shape shows through at every size. Used where the brand
// stands in for UI chrome (e.g. the collapsed-sidebar restore button).
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
        display: "block",
      }}
    />
  );
}
