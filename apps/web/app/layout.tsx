import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Ijara360 — управление домом', description: 'Комнаты, спальные места и порядок в вашем доме.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
