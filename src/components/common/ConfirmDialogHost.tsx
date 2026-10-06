// Host for the in-app confirm prompt (state/confirm.ts). Mounted once at the
// shell so any caller — sidebar, settings panel, vault tree — can await
// `confirmDialog(...)` without rendering its own modal.
import { Modal } from "./Modal";
import { useConfirmStore } from "../../state/confirm";

export function ConfirmDialogHost() {
  const current = useConfirmStore((s) => s.current);
  const settle = useConfirmStore((s) => s.settle);
  if (!current) return null;
  return (
    <Modal
      title={current.title}
      onClose={() => settle(false)}
      actions={
        <>
          <button onClick={() => settle(false)}>{current.cancelLabel ?? "Cancel"}</button>
          <button
            className={current.danger === false ? "primary" : "primary danger"}
            onClick={() => settle(true)}
          >
            {current.confirmLabel ?? "Delete"}
          </button>
        </>
      }
    >
      <p>{current.body}</p>
    </Modal>
  );
}
