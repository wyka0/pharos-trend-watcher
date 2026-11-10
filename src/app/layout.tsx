import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: 'Trend Watcher — Pharos Atlantic Testnet',
  description:
    'Stateful multi-observation trend watcher with persistent disk memory, hash-chained observations, single-spike rejection and on-chain Proof-of-Trend anchoring on Pharos Atlantic Testnet (688689).',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
