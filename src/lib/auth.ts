// JWT Authentication utilities

import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { randomBytes, timingSafeEqual } from "crypto";

// Auto-generated JWT secret (persists for the lifetime of the process)
let generatedJwtSecret: string | null = null;

/**
 * Get JWT secret - from environment or auto-generated
 * Similar to getProxyApiKey pattern for consistency
 */
function getJwtSecret(): string {
  if (process.env.JWT_SECRET) {
    return process.env.JWT_SECRET;
  }

  if (!generatedJwtSecret) {
    generatedJwtSecret = randomBytes(32).toString("base64");
  }

  return generatedJwtSecret;
}

const JWT_EXPIRES_IN = "7d";

interface JWTPayload {
  iat: number;
  exp: number;
}

/**
 * Verify admin password and generate JWT token
 */
export async function authenticateAdmin(password: string): Promise<string | null> {
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    return null;
  }

  // Support both plain text and bcrypt hashed passwords
  let isValid = false;

  if (adminPassword.startsWith("$2")) {
    // Bcrypt hash
    isValid = await bcrypt.compare(password, adminPassword);
  } else {
    // 常数时间比较，防止时序攻击
    const a = Buffer.from(password);
    const b = Buffer.from(adminPassword);
    isValid = a.length === b.length && timingSafeEqual(a, b);
  }

  if (!isValid) {
    return null;
  }

  // Generate JWT token
  const token = jwt.sign({} as Omit<JWTPayload, "iat" | "exp">, getJwtSecret(), {
    expiresIn: JWT_EXPIRES_IN,
  });

  return token;
}

/**
 * Verify JWT token and return payload
 */
export function verifyToken(token: string): JWTPayload | null {
  try {
    const payload = jwt.verify(token, getJwtSecret()) as JWTPayload;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Extract token from Authorization header
 */
export function extractToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return authHeader;
}

