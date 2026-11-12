'use client';
import { createContext, useContext } from 'react';

/** Abre la hoja de ajustes desde cualquier pantalla (el avatar de inicio, el perfil). */
export const AjustesCtx = createContext<{ abrir: (vista?: 'inicio' | 'apps' | 'llaves') => void }>({ abrir: () => {} });
export const useAjustes = () => useContext(AjustesCtx);
