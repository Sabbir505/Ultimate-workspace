import { useEffect } from "react";
import { useUiStore } from "../state/ui";

/** Register a popup's open state with the webview-occlusion system (M22):
 *  native browser panes hide while ANY registered popup is open, each under
 *  its OWN id — closing one must not re-expose webviews while another is
 *  still open. Unmounting (or `open` flipping false) unregisters the id. */
export function useOcclusion(id: string, open: boolean): void {
  const setModalOpen = useUiStore((s) => s.setModalOpen);
  useEffect(() => {
    setModalOpen(id, open);
    return () => setModalOpen(id, false);
  }, [id, open, setModalOpen]);
}
