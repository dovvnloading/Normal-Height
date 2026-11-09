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
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      onCancel={(e) => {
        e.preventDefault();
        closeRef.current();
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
