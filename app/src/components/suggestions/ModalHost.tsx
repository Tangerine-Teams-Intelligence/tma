/**
 * v1.9.0-beta.1 — Modal host.
 *
 * Reads `modalQueue` from the store, FIFO. Renders the head of the
 * queue (the oldest unhandled modal) so a sequence of modals is
 * shown in submission order. Per spec §3.4 the bus enforces the
 * ≤ 1-modal-per-session budget, so this host only ever renders one.
 *
 * Mounted from `AppShell.tsx` at the bottom; the `Modal` component
 * itself portals to `document.body` so its dimmed backdrop covers
 * the full viewport regardless of where this host lives.
 */

import { useStore } from "@/lib/store";
import { Modal } from "./Modal";

export function ModalHost() {
  const queue = useStore((s) => s.ui.modalQueue);
  const dismissModal = useStore((s) => s.ui.dismissModal);
  const head = queue[0];

  if (!head) return null;

  return (
    <Modal
      {...head}
      onCancel={() => {
        try {
          head.onCancel?.();
        } finally {
          dismissModal(head.id);
        }
      }}
      onConfirm={() => {
        try {
          head.onConfirm?.();
        } finally {
          dismissModal(head.id);
        }
      }}
    />
  );
}
