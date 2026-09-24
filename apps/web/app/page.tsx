import Link from "next/link";

/**
 * Landing entry. The full public brand & trust portal lives under `(public)`
 * (task 24.1); this root simply points visitors to the Observer portal.
 */
export default function HomePage(): JSX.Element {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-3xl font-semibold text-typography">Kshema</h1>
      <p className="text-lg text-typography/80">
        Calm, dignified ambient care for the people you hold close.
      </p>
      <Link
        href="/dashboard"
        className="rounded-full bg-primary-action px-6 py-3 font-medium text-white"
      >
        Open your Observer portal
      </Link>
    </main>
  );
}
