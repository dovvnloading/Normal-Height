import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
export function Modal({
  title,
  eyebrow,
  children,
  onClose,
  className = '',
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const d = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (d && !d.open) d.showModal();
    return () => {
      d?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      onCancel={(e) => {
        e.preventDefault();
        closeRef.current();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Tab' || event.defaultPrevented) return;
        const dialog = event.currentTarget;
        const controls = [
          ...dialog.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
          ),
        ].filter(
          (element) =>
            element.tabIndex >= 0 &&
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== 'hidden',
        );
        const first = controls[0],
          last = controls.at(-1);
        const active = document.activeElement;
        // Native modal dialogs keep the page inert, but some Chromium builds
        // still move boundary Tab navigation to browser chrome. Keep keyboard
        // traversal within the visible controls and return focus on dismissal.
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        if (
          event.shiftKey
            ? active === first || !dialog.contains(active)
            : active === last || !dialog.contains(active)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          const rect = e.currentTarget.getBoundingClientRect();
          if (
            e.clientX < rect.left ||
            e.clientX > rect.right ||
            e.clientY < rect.top ||
            e.clientY > rect.bottom
          )
            closeRef.current();
        }
      }}
      aria-label={title}
    >
      <header className="modal-header">
        <div>
          {eyebrow && <div className="eyebrow">{eyebrow}</div>}
          <h2>{title}</h2>
        </div>
        <button
          className="icon-button"
          aria-label={`Close ${title}`}
          onClick={() => closeRef.current()}
        >
          <X size={18} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
