'use client';
import { useEffect, useRef } from 'react';

export default function Modal({ abierto, onCerrar, children, bloqueado }: { abierto: boolean; onCerrar: () => void; children: React.ReactNode; bloqueado?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (abierto && !d.open) d.showModal();
    if (!abierto && d.open) d.close();
  }, [abierto]);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(e) => { e.preventDefault(); if (!bloqueado) onCerrar(); }}
      onClick={(e) => { if (e.target === ref.current && !bloqueado) onCerrar(); }}
    >
      {abierto && <div className="modal-caja">{children}</div>}
    </dialog>
  );
}
