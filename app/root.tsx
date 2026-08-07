import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@300;400;500;600;700&family=Noto+Sans+Bengali:wght@400;500;600;700&family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="bn" dir="ltr">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>আমার হিসাব | Personal Family Finance Manager</title>
        <Meta />
        <Links />
      </head>
      <body className="bg-slate-900 text-slate-100 min-h-screen font-sans antialiased selection:bg-emerald-500 selection:text-white">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "সমস্যা হয়েছে!";
  let details = "একটি অপ্রত্যাশিত ত্রুটি ঘটেছে।";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "৪০৪ - পেজ পাওয়া যায়নি" : "ত্রুটি";
    details =
      error.status === 404
        ? "আপনি যে পৃষ্ঠাটি খুঁজছেন সেটি বিদ্যমান নেই।"
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-slate-950 text-slate-100">
      <div className="max-w-md w-full p-8 rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl text-center">
        <div className="w-16 h-16 bg-red-500/10 text-red-400 rounded-full flex items-center justify-center mx-auto mb-4 text-2xl font-bold">
          !
        </div>
        <h1 className="text-2xl font-bold text-slate-100 mb-2">{message}</h1>
        <p className="text-slate-400 mb-6">{details}</p>
        <a
          href="/"
          className="inline-block px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition duration-200"
        >
          ড্যাশবোর্ডে ফিরে যান
        </a>
        {stack && (
          <pre className="mt-6 text-left text-xs bg-slate-950 p-4 rounded-xl text-red-300 overflow-x-auto border border-slate-800">
            <code>{stack}</code>
          </pre>
        )}
      </div>
    </main>
  );
}
