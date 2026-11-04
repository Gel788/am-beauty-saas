import { NextResponse } from "next/server";
import { resolvePublicBranch, asOnline, publicCatalog } from "@/server/booking";

/** PWA-INSTALL-02: a client can put the salon's booking page on the home screen. */
export async function GET(_request: Request, { params }: { params: Promise<{ tenant: string; branch: string }> }) {
  const { tenant, branch } = await params;
  let name = "Запись в салон";
  let accent = "#c2185b";
  try {
    const ids = await resolvePublicBranch(tenant, branch);
    const catalog = await asOnline(ids.tenantId, (ctx) => publicCatalog(ctx, ids.branchId));
    name = catalog.branch.name;
    accent = catalog.branch.accent || accent;
  } catch {
    // Unknown or switched-off page: a plain manifest; the page itself says what is wrong.
  }
  const start = `/b/${encodeURIComponent(tenant)}/${encodeURIComponent(branch)}`;
  return NextResponse.json(
    {
      id: start,
      name: `${name}: запись`,
      short_name: name.length > 14 ? "Запись" : name,
      start_url: `${start}?src=app`,
      scope: start,
      display: "standalone",
      background_color: "#ffffff",
      theme_color: accent,
      lang: "ru",
      icons: [
        { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" } },
  );
}
