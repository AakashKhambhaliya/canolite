import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { isUrlSafe, safeFetch } from "@/lib/ssrf";

const WEBHOOK_TIMEOUT_MS = 10_000;

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { webhookUrl } = await request.json();

    if (!webhookUrl) {
      return NextResponse.json(
        { error: "webhookUrl is required" },
        { status: 400 }
      );
    }

    // SSRF guard: same rule the real webhook-delivery paths enforce — only
    // public http(s) hosts, never localhost / private / metadata addresses.
    if (!(await isUrlSafe(webhookUrl))) {
      return NextResponse.json(
        { error: "webhookUrl must be a public http(s) URL" },
        { status: 400 }
      );
    }

    // Send test webhook
    const payload = {
      event: "test",
      uid: "test_webhook_ping",
      status: "done",
      image_url: "https://via.placeholder.com/1080x1350",
      timestamp: new Date().toISOString(),
    };

    // Bound the request so a hung endpoint can't tie up the server.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    let response: Response;
    try {
      // safeFetch re-checks every redirect hop — the isUrlSafe() call above
      // only validated the URL the user typed in, not wherever it might
      // redirect to.
      response = await safeFetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Canolite-Event": "test",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      return NextResponse.json(
        { error: `Webhook returned ${response.status}` },
        { status: 400 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to send webhook" },
      { status: 500 }
    );
  }
}
