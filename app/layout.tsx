import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Albert NO.485', description: 'Napolitansk pizza på Pilgatan 3 i Varberg.' };
export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="sv"><body>{children}</body></html>; }
