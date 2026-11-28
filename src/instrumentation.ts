/** Next.js startup hook: the server process takes the Settings page's provider and model choices too. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { refreshProcessSettings } = await import("@/lib/settings/model-settings");
  await refreshProcessSettings();
}
