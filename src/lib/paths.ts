/** True when changedPath is root itself or lies underneath it. Accepts both
 *  Windows (\) and POSIX (/) separators regardless of the host platform,
 *  because fs-change events and watched roots may mix conventions. */
export function pathUnderChanged(root: string, changedPath: string): boolean {
  return (
    changedPath === root ||
    changedPath.startsWith(root + "\\") ||
    changedPath.startsWith(root + "/")
  );
}
