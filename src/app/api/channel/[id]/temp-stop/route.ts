import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/middleware/auth";
import { prisma } from "@/lib/prisma";
import {
  getTemporaryStoppedModelsForChannel,
  shouldAllowAdminTemporaryStopBypass,
} from "@/lib/proxy";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const channel = await prisma.channel.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
      },
    });

    if (!channel) {
      return NextResponse.json(
        { error: "渠道不存在", code: "NOT_FOUND" },
        { status: 404 }
      );
    }

    const models = await getTemporaryStoppedModelsForChannel(channel.id);
    const credentialMap = new Map<string, { credentialKey: string; keyType: "main" | "channel"; channelKeyId: string | null; name: string; modelCount: number }>();

    for (const model of models) {
      const credential = model.temporaryStoppedCredential;
      const current = credentialMap.get(credential.credentialKey);
      if (current) {
        current.modelCount += 1;
      } else {
        credentialMap.set(credential.credentialKey, {
          ...credential,
          modelCount: 1,
        });
      }
    }

    return NextResponse.json({
      channelId: channel.id,
      channelName: channel.name,
      allowAdminBypass: shouldAllowAdminTemporaryStopBypass(),
      temporaryStoppedModelCount: models.length,
      temporaryStoppedCredentials: Array.from(credentialMap.values()).sort((a, b) => {
        if (a.keyType !== b.keyType) {
          return a.keyType === "main" ? -1 : 1;
        }
        return a.name.localeCompare(b.name, "zh-CN");
      }),
      models,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "获取临时停用信息失败";
    return NextResponse.json(
      { error: message, code: "FETCH_TEMP_STOP_FAILED" },
      { status: 500 }
    );
  }
}
