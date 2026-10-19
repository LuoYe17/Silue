// Cloudflare Worker：以后负责同步和后台代跑，见 .agents/notes/proposed/architecture/2026-10-19-sync-e2e-cloudflare.md
import { APP_NAME } from "@silue/core";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ app: APP_NAME, ok: true });
    }
    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler;
