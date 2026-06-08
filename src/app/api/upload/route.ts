import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/db";
import { assets } from "@/db/schema";
import { uploadFile } from "@/lib/storage";
import { generateId } from "@/lib/utils";

const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || "10", 10);
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;

const ALLOWED_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/gif": "gif",
  "font/ttf": "ttf",
  "font/otf": "otf",
  "font/woff": "woff",
  "font/woff2": "woff2",
  "application/x-font-ttf": "ttf",
  "application/x-font-otf": "otf",
};

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      );
    }

    // Validate type
    const ext = ALLOWED_TYPES[file.type];
    if (!ext) {
      return NextResponse.json(
        {
          error: `File type "${file.type}" not allowed. Allowed: ${Object.keys(ALLOWED_TYPES).join(", ")}`,
        },
        { status: 400 }
      );
    }

    // Validate size
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File too large. Maximum ${MAX_UPLOAD_MB}MB.` },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const key = `uploads/${user.projectId}/${generateId()}/${file.name}`;

    const url = await uploadFile(key, buffer, file.type);

    // Save asset record
    const [asset] = await db
      .insert(assets)
      .values({
        projectId: user.projectId,
        name: file.name,
        url,
        type: file.type.startsWith("image") ? "image" : "font",
        mimeType: file.type,
        size: file.size,
      })
      .returning();

    return NextResponse.json(
      {
        id: asset.id,
        url: asset.url,
        name: asset.name,
        type: asset.type,
        size: asset.size,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
