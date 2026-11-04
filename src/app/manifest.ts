import type { MetadataRoute } from "next";

/** PWA-INSTALL-01: the staff app. Masters land on «Мой день», the desk on the journal. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/journal",
    name: "Am Beauty — журнал салона",
    short_name: "Am Beauty",
    description: "Журнал записей, клиенты и касса салона",
    start_url: "/journal?app=1",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f7f2fb",
    theme_color: "#7c5cff",
    lang: "ru",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Журнал на сегодня", url: "/journal?app=1", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Мой день", url: "/me", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Клиенты", url: "/clients", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
