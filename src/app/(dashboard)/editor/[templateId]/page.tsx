"use client";
import { useParams, useRouter } from "next/navigation";
import { EditorWorkspace } from "@/components/editor/editor-workspace";

export default function EditorPage() {
  const { templateId } = useParams<{ templateId: string }>();
  const router = useRouter();
  return <EditorWorkspace key={templateId} templateId={templateId} navigate={router.push} />;
}
