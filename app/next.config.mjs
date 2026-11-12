import path from 'node:path';
/** Las reescrituras se fijan al compilar: si el gateway no está en 9942, define AGENTES_GATEWAY_URL antes de `npm run build`. */
const gateway = process.env.AGENTES_GATEWAY_URL || 'http://127.0.0.1:9942';

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Sin gzip propio: comprimir junta toda la respuesta y el chat (SSE) dejaría de llegar en vivo. Cloudflare ya comprime.
  compress: false,
  webpack(cfg) {
    cfg.resolve.alias['@'] = path.resolve(process.cwd(), 'src');
    return cfg;
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${gateway}/api/:path*` }];
  },
};
export default config;
