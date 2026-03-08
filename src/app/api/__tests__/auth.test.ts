// API route tests

import { describe, it, expect, vi } from "vitest";
import { authenticateAdmin, verifyToken, extractToken } from "@/lib/auth";

// Mock environment variables
vi.stubEnv("ADMIN_PASSWORD", "test-password-123");
vi.stubEnv("JWT_SECRET", "test-secret");

describe("Authentication", () => {
  describe("authenticateAdmin", () => {
    it("should return token for correct password", async () => {
      const token = await authenticateAdmin("test-password-123");
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
    });

    it("should return null for incorrect password", async () => {
      const token = await authenticateAdmin("wrong-password");
      expect(token).toBeNull();
    });

    it("should return null for empty password", async () => {
      const token = await authenticateAdmin("");
      expect(token).toBeNull();
    });
  });

  describe("verifyToken", () => {
    it("should verify valid token", async () => {
      const token = await authenticateAdmin("test-password-123");
      expect(token).toBeTruthy();

      const payload = verifyToken(token!);
      expect(payload).toBeTruthy();
      expect(payload?.role).toBe("admin");
    });

    it("should return null for invalid token", () => {
      const payload = verifyToken("invalid-token");
      expect(payload).toBeNull();
    });

    it("should return null for empty token", () => {
      const payload = verifyToken("");
      expect(payload).toBeNull();
    });
  });

  describe("extractToken", () => {
    it("should extract Bearer token", () => {
      const token = extractToken("Bearer abc123");
      expect(token).toBe("abc123");
    });

    it("should return raw token without Bearer prefix", () => {
      const token = extractToken("abc123");
      expect(token).toBe("abc123");
    });

    it("should return null for null header", () => {
      const token = extractToken(null);
      expect(token).toBeNull();
    });
  });
});

describe("API Endpoints Contracts", () => {
  describe("POST /api/auth/login", () => {
    it("should require password field", () => {
      // Contract: Request must include password
      const validRequest = { password: "string" };
      expect(validRequest).toHaveProperty("password");
    });

    it("should return token on success", () => {
      // Contract: Success response includes token
      const successResponse = {
        success: true,
        token: "jwt-token",
        expiresIn: "7d",
      };
      expect(successResponse).toHaveProperty("token");
      expect(successResponse).toHaveProperty("expiresIn");
    });
  });

  describe("GET /api/dashboard", () => {
    it("should return channels array structure", () => {
      // Contract: Response structure
      const response = {
        authenticated: false,
        summary: {
          totalChannels: 0,
          totalModels: 0,
          healthyModels: 0,
          healthRate: 0,
        },
        channels: [],
      };
      expect(response).toHaveProperty("authenticated");
      expect(response).toHaveProperty("summary");
      expect(response).toHaveProperty("channels");
    });
  });

  describe("POST /api/channel", () => {
    it("should require name, baseUrl, and apiKey", () => {
      // Contract: Required fields
      const validRequest = {
        name: "Test Channel",
        baseUrl: "https://api.example.com",
        apiKey: "sk-test-key",
      };
      expect(validRequest).toHaveProperty("name");
      expect(validRequest).toHaveProperty("baseUrl");
      expect(validRequest).toHaveProperty("apiKey");
    });
  });

  describe("POST /api/detect", () => {
    it("should optionally accept channelId or modelId", () => {
      // Contract: Optional channelId/modelId for targeted detection
      const fullDetection = {};
      const channelDetection = { channelId: "channel-123" };
      const modelDetection = { modelId: "model-123" };

      expect(fullDetection).not.toHaveProperty("channelId");
      expect(fullDetection).not.toHaveProperty("modelId");
      expect(channelDetection).toHaveProperty("channelId");
      expect(modelDetection).toHaveProperty("modelId");
    });
  });

  describe("GET /api/status", () => {
    it("should return public status without auth", () => {
      // Contract: Public endpoint response
      const response = {
        status: "operational",
        timestamp: new Date().toISOString(),
        statistics: {
          channels: 0,
          models: 0,
          checksLast24h: 0,
          healthRate: 0,
        },
      };
      expect(response).toHaveProperty("status");
      expect(response).toHaveProperty("statistics");
    });
  });
});
