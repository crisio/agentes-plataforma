import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agentes GC',
  description: 'La casa de los agentes de la empresa.',
  icons: { icon: '/icono.svg', apple: '/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'Agentes GC', statusBarStyle: 'black-translucent' },
};
export const viewport: Viewport = {
  themeColor: '#121110',
  colorScheme: 'dark',
  interactiveWidget: 'resizes-content', // Android: el teclado achica la vista y la barra de escribir queda visible
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function Raiz({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400&family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
