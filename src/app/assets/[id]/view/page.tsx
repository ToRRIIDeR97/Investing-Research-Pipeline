import { redirect } from "next/navigation";

export default async function LegacyResearchView({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const { id } = await params;
  const { run } = await searchParams;
  redirect(`/assets/${encodeURIComponent(id)}/research/general${run ? `?run=${encodeURIComponent(run)}` : ""}`);
}
