import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "머무룸 DX",
    short_name: "머무룸",
    description: "머무룸 예약 및 운영 관리",
    start_url: "/",
    display: "standalone",
    background_color: "#f8fafc",
    theme_color: "#4f46e5",
  };
}
