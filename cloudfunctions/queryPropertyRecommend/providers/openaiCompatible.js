const http = require("http");
const https = require("https");
const { URL } = require("url");

const MODE = "openai_compatible";
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const DEFAULT_MODEL = "qwen-plus";
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.OPENAI_COMPAT_TIMEOUT_MS || "12000", 10);
let lastProxySignature = "";

function normalizeText(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

function sanitizeSensitiveText(value) {
  const text = normalizeText(value);
  if (!text) {
    return "";
  }

  return text
    .replace(/sk-[^\s"',}]{4,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***")
    .replace(/"api[_-]?key"\s*:\s*"[^"]+"/gi, '"api_key":"***"')
    .replace(/"authorization"\s*:\s*"[^"]+"/gi, '"authorization":"***"');
}

function toPreviewText(value, maxLen = 160) {
  const text = sanitizeSensitiveText(value);
  if (!text) {
    return "";
  }
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function getEnvValue(key, fallback = "") {
  return normalizeText(process.env[key], fallback);
}

function getProxyEnvValue() {
  return (
    getEnvValue("OPENAI_COMPAT_PROXY_URL") ||
    getEnvValue("HTTPS_PROXY") ||
    getEnvValue("https_proxy") ||
    getEnvValue("HTTP_PROXY") ||
    getEnvValue("http_proxy")
  );
}

function getApiKey() {
  return (
    getEnvValue("OPENAI_COMPAT_API_KEY") ||
    getEnvValue("BAILIAN_API_KEY") ||
    getEnvValue("DASHSCOPE_API_KEY")
  );
}

function getModelName() {
  return (
    getEnvValue("OPENAI_COMPAT_MODEL") ||
    getEnvValue("BAILIAN_COMPAT_MODEL") ||
    getEnvValue("DASHSCOPE_MODEL") ||
    DEFAULT_MODEL
  );
}

function applyGlobalProxyIfNeeded() {
  if (typeof http.setGlobalProxyFromEnv !== "function") {
    return;
  }

  const proxyUrl = getProxyEnvValue();
  const noProxy = getEnvValue("NO_PROXY") || getEnvValue("no_proxy");
  const signature = JSON.stringify({
    proxyUrl,
    noProxy
  });

  if (signature === lastProxySignature) {
    return;
  }

  lastProxySignature = signature;
  http.setGlobalProxyFromEnv({
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: noProxy
  });
}

function stripCodeFence(value) {
  const text = normalizeText(value);
  if (!text.startsWith("```")) {
    return text;
  }
  return text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
}

function parseJson(value) {
  const text = stripCodeFence(value);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function getEndpointUrl() {
  const raw =
    getEnvValue("OPENAI_COMPAT_BASE_URL") ||
    getEnvValue("BAILIAN_COMPAT_BASE_URL") ||
    getEnvValue("DASHSCOPE_BASE_URL") ||
    DEFAULT_BASE_URL;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.toString();
  } catch (err) {
    return "";
  }
}

function postJson(url, payload, token) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const requester = parsed.protocol === "https:" ? https : http;
    const body = JSON.stringify(payload);

    const request = requester.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${token}`
        }
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode || 0,
            body: text
          });
        });
      }
    );

    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`request timeout: ${REQUEST_TIMEOUT_MS}ms`));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function buildPrompt(payload) {
  const query = normalizeText(payload.query);
  const context = payload.context && typeof payload.context === "object" ? payload.context : {};
  return [
    "你是房产决策顾问。",
    "只输出 JSON，不要输出 markdown。",
    "JSON 顶层字段只允许：understanding, summary, questions, recommendations, advice, next_steps, session_summary。",
    "questions 为字符串数组，recommendations 为对象数组，next_steps 为字符串数组。",
    "如果没有推荐就给 summary，不要编造字段。",
    `用户问题：${query}`,
    `上下文：${JSON.stringify(context)}`
  ].join("\n");
}

function normalizeResponseContent(content) {
  const parsed = parseJson(content);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return {
      understanding: normalizeText(parsed.understanding),
      summary: normalizeText(parsed.summary || parsed.reply || parsed.message),
      questions: Array.isArray(parsed.questions) ? parsed.questions.filter(Boolean) : [],
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.filter((item) => item && typeof item === "object")
        : [],
      advice: normalizeText(parsed.advice),
      next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps.filter(Boolean) : [],
      session_summary: normalizeText(parsed.session_summary)
    };
  }

  return {
    understanding: "",
    summary: normalizeText(content),
    questions: [],
    recommendations: [],
    advice: "",
    next_steps: [],
    session_summary: ""
  };
}

async function request(payload, { traceId, buildErrorResult, startTime }) {
  const endpoint = getEndpointUrl();
  const token = getApiKey();
  const model = getModelName();

  if (!endpoint) {
    return buildErrorResult({
      code: "OPENAI_COMPAT_ENDPOINT_MISSING",
      message: "missing OPENAI_COMPAT_BASE_URL",
      traceId,
      durationMs: Date.now() - startTime,
      mode: MODE
    });
  }

  if (!token) {
    return buildErrorResult({
      code: "OPENAI_COMPAT_API_KEY_MISSING",
      message: "missing OPENAI_COMPAT_API_KEY/BAILIAN_API_KEY/DASHSCOPE_API_KEY",
      traceId,
      durationMs: Date.now() - startTime,
      mode: MODE
    });
  }

  try {
    applyGlobalProxyIfNeeded();
    const response = await postJson(
      endpoint,
      {
        model,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: "You are a Chinese real-estate decision assistant. Output JSON only."
          },
          {
            role: "user",
            content: buildPrompt(payload)
          }
        ]
      },
      token
    );

    const parsed = parseJson(response.body);
    if (!parsed || typeof parsed !== "object") {
      return buildErrorResult({
        code: "UPSTREAM_INVALID_JSON",
        message: "openai compatible response is not valid JSON",
        traceId,
        durationMs: Date.now() - startTime,
        details: toPreviewText(response.body),
        mode: MODE
      });
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return buildErrorResult({
        code: "UPSTREAM_HTTP_ERROR",
        message: `openai compatible status ${response.statusCode}`,
        traceId,
        durationMs: Date.now() - startTime,
        details: toPreviewText(response.body),
        mode: MODE
      });
    }

    const content = normalizeText(
      parsed &&
        parsed.choices &&
        parsed.choices[0] &&
        parsed.choices[0].message &&
        parsed.choices[0].message.content
    );
    const normalizedData = normalizeResponseContent(content);
    const type = normalizedData.questions.length ? "clarification_needed" : "recommendation";

    return {
      success: true,
      type,
      data: normalizedData,
      error: null,
      meta: {
        trace_id: traceId,
        duration_ms: Date.now() - startTime,
        mode: MODE,
        model
      }
    };
  } catch (err) {
    return buildErrorResult({
      code: "REQUEST_FAILED",
      message: "openai compatible request failed",
      traceId,
      durationMs: Date.now() - startTime,
      details: toPreviewText(err && (err.message || err.errMsg)),
      mode: MODE
    });
  }
}

module.exports = {
  mode: MODE,
  request
};
