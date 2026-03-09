// Detection system type definitions

import { EndpointType, CheckStatus } from "@/generated/prisma";

// Endpoint type detection result
export interface EndpointDetection {
  type: EndpointType;
  url: string;
  requestBody: Record<string, unknown>;
  headers: Record<string, string>;
}

// Detection result
export interface DetectionResult {
  status: CheckStatus;
  latency: number;
  statusCode?: number;
  errorMsg?: string;
  endpointType: EndpointType;
  responseContent?: string;
}

// Model info from /v1/models
export interface ModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

// Detection job data
export interface DetectionJobData {
  channelId: string;
  modelId: string;
  modelName: string;
  baseUrl: string;
  apiKey: string;
  proxy?: string | null;
  endpointType: EndpointType;
  sessionId?: string | null;
}

// Channel with models for batch detection
export interface ChannelWithModels {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  proxy: string | null;
  models: {
    id: string;
    modelName: string;
    detectedEndpoints: string[];
  }[];
}

// Result of fetching models from /v1/models
export interface FetchModelsResult {
  models: string[];
  error?: string;
}
