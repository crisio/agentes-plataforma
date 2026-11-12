'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { Yo } from '@/lib/tipos';
import { YoCtx } from '@/lib/yo';
import { AjustesCtx } from '@/lib/ajustes';
import Ajustes from '@/components/Ajustes';

/** Sin barra lateral: inicio → chat, perfil del agente y ajustes (hoja). */
export default function Panel({ children }: { children: React.ReactNode }) {
  const [yo, setYo] = useState<Yo | null>(null);
  const [ajustes, setAjustes] = useState<{ abierto: boolean; vista: 'inicio' | 'apps' | 'llaves' }>({ abierto: false, vista: 'inicio' });

  useEffect(() => { api<Yo>('/yo').then(setYo).catch(() => {}); }, []);
  const abrir = useCallback((vista: 'inicio' | 'apps' | 'llaves' = 'inicio') => setAjustes({ abierto: true, vista }), []);

  if (!yo) return <div className="pagina"><div className="cargando" style={{ maxWidth: 520, margin: '60px auto 0' }} /></div>;

  return (
    <YoCtx.Provider value={yo}>
      <AjustesCtx.Provider value={{ abrir }}>
        {children}
        <Ajustes abierto={ajustes.abierto} vistaInicial={ajustes.vista} onCerrar={() => setAjustes((a) => ({ ...a, abierto: false }))} />
      </AjustesCtx.Provider>
    </YoCtx.Provider>
  );
}
