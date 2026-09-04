// Creates a persisted appraisal on the public Goonpraisal (go-evepraisal fork)
// tool and returns its URL, so the UI can send the user straight to
// appraise.gnf.lt to see every component priced there.
// https://appraise.gnf.lt/api-docs
const ENDPOINT = "https://appraise.gnf.lt/appraisal.json?market=jita";

export async function createAppraisalLink(lines) {
  const body = lines.join("\n");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        "User-Agent": "eve-production-calc (local private tool)",
      },
      body,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Goonpraisal error ${res.status}`);
    const data = await res.json();
    const appraisal = data.appraisal;
    if (!appraisal?.id) throw new Error(data.error_message ?? "Goonpraisal did not return an appraisal id");
    return `https://appraise.gnf.lt/a/${appraisal.id}`;
  } finally {
    clearTimeout(timeout);
  }
}
