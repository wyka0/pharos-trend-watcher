import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The watcher is a self-contained skill; nothing needs to be inlined at build time.
  reactStrictMode: true,
};

export default nextConfig;
