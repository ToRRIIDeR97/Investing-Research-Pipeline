"use client";

import { useRouter } from "next/navigation";

/**
 * Custom layout for Run Research — no sidebar per §24.2.
 */
export default function RunLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
