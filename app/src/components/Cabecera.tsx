'use client';
import Link from 'next/link';
import Icono from '@/components/Icono';

/** Cabecera de las páginas internas: botón redondo para volver, título centrado y acciones a la derecha. */
export default function Cabecera({ titulo, volver = '/', acciones }: { titulo: string; volver?: string; acciones?: React.ReactNode }) {
  return (
    <header className="cabecera">
      <Link href={volver} className="redondo" aria-label="Volver"><Icono n="atras" t={22} /></Link>
      <h1>{titulo}</h1>
      <div className="acciones">{acciones}</div>
    </header>
  );
}
