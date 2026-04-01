import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '7 Design Things API',
  description: 'Backend API server',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
