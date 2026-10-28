import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconClose } from "./Icons";
export default function ProductivityDialog({
  title,
  onClose,
  children,
  className = "",
  closing = false,
}: {
  className?: string;
  closing?: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    ref.current?.querySelector<HTMLElement>("[data-initial-focus]:not(:disabled)")?.focus();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`productivity-dialog ${className} ${closing ? "is-closing" : ""}`}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id={id}>{title}</h2>
        <button
          className="btn btn-ghost btn-icon"
          aria-label="Close dialog"
          type="button"
          onClick={onClose}
        >
          <IconClose size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
