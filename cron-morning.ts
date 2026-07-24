export default async (): Promise<Response> => {
  const base = process.env.URL;
  if (!base) return new Response("Site URL is not available.", { status: 500 });
  const key = process.env.CRON_SECRET ?? "";
  await fetch(`${base}/.netlify/functions/build-slate-background?key=${encodeURIComponent(key)}`, {
    method: "POST",
  }).catch(() => undefined);
  return new Response("triggered");
};

export const config = { schedule: "0 11 * * *" };
