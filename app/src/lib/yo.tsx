'use client';
import { createContext, useContext } from 'react';
import type { Yo } from './tipos';

export const YoCtx = createContext<Yo | null>(null);
export const useYo = () => useContext(YoCtx)!;
export const tiene = (yo: Yo, ...r: string[]) => r.some((x) => yo.roles.includes(x));
