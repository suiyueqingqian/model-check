// API Proxy documentation page

"use client";

import { useState, useEffect } from "react";
import { Copy, Check, ArrowLeft } from "lucide-react";
import Link from "next/link";

export default function ProxyDocsPage() {
  const [baseUrl, setBaseUrl] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    // Get current origin for examples
    setBaseUrl(window.location.origin);
  }, []);

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const CodeBlock = ({ code, id }: { code: string; id: string }) => (
    <div className="relative group">
      <pre className="bg-muted p-4 rounded-lg overflow-x-auto text-sm">
        <code>{code}</code>
      </pre>
      <button
        onClick={() => copyToClipboard(code, id)}
        className="absolute top-2 right-2 p-2 rounded-md bg-background/80 opacity-0 group-hover:opacity-100 transition-opacity"
        title="复制"
      >
        {copied === id ? (
          <Check className="h-4 w-4 text-green-500" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </button>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Header */}
        <div className="mb-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-muted-foreground hover:text-foreground mb-4"
          >
            <ArrowLeft className="h-4 w-4" />
            返回监控面板
          </Link>
          <h1 className="text-3xl font-bold mb-2">API 代理使用文档</h1>
          <p className="text-muted-foreground">
            本系统提供 API 代理功能，可将请求自动路由到对应的渠道端点。
          </p>
        </div>

        {/* Overview */}
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-4">概述</h2>
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="mb-2">
              代理会根据请求中的 <code className="bg-muted px-1 rounded">model</code> 字段自动匹配数据库中的渠道，
              并将请求转发到对应的上游 API。
            </p>
            <p className="text-muted-foreground text-sm">
              只有检测成功的模型才会出现在模型列表中，确保代理的可用性。
            </p>
          </div>
        </section>

        {/* Base URL */}
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-4">Base URL</h2>
          <CodeBlock code={baseUrl || "https://your-domain.com"} id="baseurl" />
        </section>

        {/* Endpoints */}
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-4">支持的端点</h2>
          <div className="space-y-4">
            <div className="bg-card border border-border rounded-lg p-4">
              <h3 className="font-medium mb-2">获取模型列表</h3>
              <code className="text-blue-500">GET /v1/models</code>
              <p className="text-sm text-muted-foreground mt-2">
                返回所有可用模型，包含渠道信息（owned_by 字段）
              </p>
            </div>

            <div className="bg-card border border-border rounded-lg p-4">
              <h3 className="font-medium mb-2">OpenAI Chat Completions</h3>
              <code className="text-blue-500">POST /v1/chat/completions</code>
              <p className="text-sm text-muted-foreground mt-2">
                兼容 OpenAI Chat API，支持流式和非流式响应
              </p>
            </div>

            <div className="bg-card border border-border rounded-lg p-4">
              <h3 className="font-medium mb-2">Claude Messages</h3>
              <code className="text-blue-500">POST /v1/messages</code>
              <p className="text-sm text-muted-foreground mt-2">
                兼容 Anthropic Claude Messages API
              </p>
            </div>

            <div className="bg-card border border-border rounded-lg p-4">
              <h3 className="font-medium mb-2">OpenAI Responses (Codex)</h3>
              <code className="text-blue-500">POST /v1/responses</code>
              <p className="text-sm text-muted-foreground mt-2">
                兼容 OpenAI Responses API
              </p>
            </div>

            <div className="bg-card border border-border rounded-lg p-4">
              <h3 className="font-medium mb-2">Gemini</h3>
              <code className="text-blue-500">POST /v1beta/models/{"{model}"}:generateContent</code>
              <br />
              <code className="text-blue-500">POST /v1beta/models/{"{model}"}:streamGenerateContent</code>
              <p className="text-sm text-muted-foreground mt-2">
                兼容 Google Gemini API
              </p>
            </div>
          </div>
        </section>

        {/* Usage Examples */}
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-4">使用示例</h2>

          <div className="space-y-6">
            {/* Get Models */}
            <div>
              <h3 className="font-medium mb-2">1. 获取可用模型列表</h3>
              <CodeBlock
                code={`curl ${baseUrl || "https://your-domain.com"}/v1/models`}
                id="example-models"
              />
              <p className="text-sm text-muted-foreground mt-2">
                响应中的 <code className="bg-muted px-1 rounded">owned_by</code> 字段表示模型所属的渠道名称。
              </p>
            </div>

            {/* Chat */}
            <div>
              <h3 className="font-medium mb-2">2. OpenAI Chat (流式)</h3>
              <CodeBlock
                code={`curl ${baseUrl || "https://your-domain.com"}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'`}
                id="example-chat"
              />
            </div>

            {/* Claude */}
            <div>
              <h3 className="font-medium mb-2">3. Claude Messages</h3>
              <CodeBlock
                code={`curl ${baseUrl || "https://your-domain.com"}/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "claude-3-5-sonnet-20241022",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'`}
                id="example-claude"
              />
            </div>

            {/* Gemini */}
            <div>
              <h3 className="font-medium mb-2">4. Gemini</h3>
              <CodeBlock
                code={`curl ${baseUrl || "https://your-domain.com"}/v1beta/models/gemini-1.5-flash:generateContent \\
  -H "Content-Type: application/json" \\
  -d '{
    "contents": [{"parts": [{"text": "Hello"}]}]
  }'`}
                id="example-gemini"
              />
            </div>
          </div>
        </section>

        {/* Client Configuration */}
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-4">客户端配置</h2>

          <div className="space-y-6">
            <div>
              <h3 className="font-medium mb-2">OpenAI Python SDK</h3>
              <CodeBlock
                code={`from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl || "https://your-domain.com"}/v1",
    api_key="not-needed"  # API Key 由服务端管理
)

response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}]
)`}
                id="config-openai"
              />
            </div>

            <div>
              <h3 className="font-medium mb-2">Anthropic Python SDK</h3>
              <CodeBlock
                code={`import anthropic

client = anthropic.Anthropic(
    base_url="${baseUrl || "https://your-domain.com"}",
    api_key="not-needed"  # API Key 由服务端管理
)

message = client.messages.create(
    model="claude-3-5-sonnet-20241022",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}]
)`}
                id="config-anthropic"
              />
            </div>
          </div>
        </section>

        {/* Notes */}
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-4">注意事项</h2>
          <ul className="list-disc list-inside space-y-2 text-muted-foreground">
            <li>模型名称必须与数据库中的模型完全匹配</li>
            <li>只有检测成功的模型才会出现在 /v1/models 列表中</li>
            <li>如果同一模型存在于多个渠道，系统会使用第一个匹配的渠道</li>
            <li>流式响应会透明转发，保持原始 SSE 格式</li>
            <li>代理超时时间为 10 分钟，支持长时间的 CLI 对话</li>
          </ul>
        </section>

        {/* Authentication */}
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-4">认证方式</h2>
          <div className="bg-card border border-border rounded-lg p-4">
            <p className="mb-3">
              如果服务端配置了 <code className="bg-muted px-1 rounded">PROXY_API_KEY</code> 环境变量，
              则需要在请求中携带 API Key：
            </p>
            <CodeBlock
              code={`# OpenAI 格式
Authorization: Bearer your-proxy-key

# Claude 格式
x-api-key: your-proxy-key

# Gemini 格式
x-goog-api-key: your-proxy-key`}
              id="auth-headers"
            />
            <p className="text-sm text-muted-foreground mt-3">
              管理员可通过 <code className="bg-muted px-1 rounded">GET /api/proxy-key</code> 接口查看当前配置的代理密钥。
            </p>
          </div>
        </section>

        {/* Nginx Configuration */}
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-4">Nginx 配置（反向代理）</h2>
          <p className="text-muted-foreground mb-4">
            如果使用 Nginx 作为反向代理，需要配置以下参数以支持流式响应和长连接：
          </p>
          <CodeBlock
            code={`location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_cache_bypass $http_upgrade;

    # 流式响应支持（重要！）
    proxy_buffering off;

    # 长连接超时（CLI 对话可能持续较长时间）
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}`}
            id="nginx-config"
          />
          <div className="mt-4 p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg">
            <p className="text-sm">
              <strong>重要：</strong>
              <code className="bg-muted px-1 rounded mx-1">proxy_buffering off</code>
              是流式响应的关键配置，否则 SSE 数据会被缓冲导致客户端无法实时接收。
              <code className="bg-muted px-1 rounded mx-1">proxy_read_timeout 600s</code>
              确保长时间的 CLI 对话不会超时断开。
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
