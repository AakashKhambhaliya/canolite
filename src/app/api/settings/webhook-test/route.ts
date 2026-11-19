import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { readHookConfig } from "@/lib/render/job-webhook";
import { sendWebhook } from "@/lib/security/webhook";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  try {
    const config = await readHookConfig(user.projectId);
    const requested = await request.json().catch(() => ({}));
    if (!config?.webhookUrl || (requested.webhookUrl && requested.webhookUrl !== config.webhookUrl)) {
      return NextResponse.json({error: "Save the webhook settings before sending a test."}, {status: 400});
    }
    await sendWebhook(config, null, "test", { uid: "test_webhook_ping", status: "done" });
    return NextResponse.json({ success: true });
  } catch { return NextResponse.json({ error: "Webhook delivery failed. Check the saved HTTPS endpoint and its response." }, { status: 502 }); }
}
