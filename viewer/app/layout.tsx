import type { Metadata } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import './globals.css';

const sans = IBM_Plex_Sans({ variable: '--font-app-sans', subsets: ['latin'], weight: ['400', '500', '600', '700'] });
const mono = IBM_Plex_Mono({ variable: '--font-app-mono', subsets: ['latin'], weight: ['500', '600'] });

export const metadata: Metadata = {
  title: 'Friedberg Infrastruktur-Viewer',
  description: 'Quellenbelegter Ist-Zustand der Bahnhofsinfrastruktur Friedberg (Hess).',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="de"><body className={`${sans.variable} ${mono.variable}`}>{children}</body></html>;
}
