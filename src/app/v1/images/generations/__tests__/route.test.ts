import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getProxyChannelCandidatesWithPermission: vi.fn(),
  buildUpstreamHeaders: vi.fn(),
  proxyRequest: vi.fn(),
  recordProxyModelResult: vi.fn(),
  errorResponse: vi.fn((message: string, status = 400) =>
    Response.json({ error: message }, { status })
  ),
  normalizeBaseUrl: vi.fn((value: string) => value.replace(/\/$/, "")),
  verifyProxyKeyAsync: vi.fn(),
}));

vi.mock("@/lib/proxy", () => mocks);

import { POST } from "../route";

describe("POST /v1/images/generations", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.verifyProxyKeyAsync.mockResolvedValue({
      keyResult: {
        valid: true,
        isEnvKey: false,
        keyRecord: { unifiedMode: false },
      },
    });
    mocks.buildUpstreamHeaders.mockReturnValue({
      Authorization: "Bearer upstream-key",
      "Content-Type": "application/json",
    });
    mocks.recordProxyModelResult.mockResolvedValue(undefined);
  });

  it("会把图片请求转发到上游 images 端点", async () => {
    mocks.getProxyChannelCandidatesWithPermission.mockResolvedValue({
      isUnifiedRouting: false,
      candidates: [
        {
          channelId: "ch_1",
          channelName: "demo",
          baseUrl: "https://api.example.com/",
          apiKey: "upstream-key",
          proxy: null,
          actualModelName: "dall-e-3",
          modelId: "model_1",
          modelStatus: true,
          preferredProxyEndpoint: null,
        },
      ],
    });
    mocks.proxyRequest.mockResolvedValue(
      new Response(JSON.stringify({ created: 1, data: [{ url: "https://img.example.com/1.png" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const request = new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "demo/dall-e-3",
        prompt: "red circle",
      }),
    });

    const response = await POST(request as NextRequest);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.data[0].url).toBe("https://img.example.com/1.png");
    expect(mocks.getProxyChannelCandidatesWithPermission).toHaveBeenCalledWith(
      "demo/dall-e-3",
      expect.any(Object),
      "IMAGE"
    );
    expect(mocks.proxyRequest).toHaveBeenCalledWith(
      "https://api.example.com/v1/images/generations",
      "POST",
      expect.any(Object),
      expect.objectContaining({
        model: "dall-e-3",
        prompt: "red circle",
      }),
      null
    );
    expect(mocks.recordProxyModelResult).toHaveBeenCalledWith(
      "model_1",
      "IMAGE",
      true,
      expect.objectContaining({
        statusCode: 200,
      })
    );
  });

  it("找不到图片模型时返回 404", async () => {
    mocks.getProxyChannelCandidatesWithPermission.mockResolvedValue({
      isUnifiedRouting: false,
      candidates: [],
    });

    const request = new Request("http://localhost/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "demo/dall-e-3",
        prompt: "red circle",
      }),
    });

    const response = await POST(request as NextRequest);
    const payload = await response.json();

    expect(response.status).toBe(404);
    expect(payload.error).toContain("Model not found");
  });
});
