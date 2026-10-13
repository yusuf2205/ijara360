import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  async rewrites() {
    return [
      // The Flutter web app lives in public/app; its entry point is index.html.
      { source: '/app', destination: '/app/index.html' },
      { source: '/app/', destination: '/app/index.html' },
      { source: '/api/:path*', destination: `${process.env.API_INTERNAL_URL || 'http://127.0.0.1:4000'}/api/:path*` }];
  },
};
export default config;
