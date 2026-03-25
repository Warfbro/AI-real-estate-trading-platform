const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const DEFAULT_MODEL = "qwen-plus";

function readApiKey() {
  const filePath = path.resolve(__dirname, "..", "新需求", "apikey");
  const text = fs.readFileSync(filePath, "utf8");
  return String(text || "").trim();
}

function getEnvValue(keys, fallback = "") {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) {
      return value;
    }
  }
  return fallback;
}

function normalizeProxyUrl(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (/^https?:\/\//i.test(text)) {
    return text;
  }
  return `http://${text}`;
}

function detectWindowsProxyUrl() {
  try {
    const command = [
      "$item = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';",
      "if ($item.ProxyEnable -eq 1 -and $item.ProxyServer) {",
      "  Write-Output $item.ProxyServer",
      "}"
    ].join(" ");
    const output = cp.execSync(`powershell -NoProfile -Command "${command}"`, {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    const raw = String(output || "").trim();
    if (!raw) {
      return "";
    }
    if (raw.includes("=")) {
      const httpsMatch = raw.match(/https=([^;]+)/i);
      const httpMatch = raw.match(/http=([^;]+)/i);
      return normalizeProxyUrl((httpsMatch && httpsMatch[1]) || (httpMatch && httpMatch[1]) || "");
    }
    return normalizeProxyUrl(raw);
  } catch (err) {
    return "";
  }
}

async function main() {
  if (!getEnvValue(["OPENAI_COMPAT_API_KEY", "BAILIAN_API_KEY", "DASHSCOPE_API_KEY"])) {
    process.env.OPENAI_COMPAT_API_KEY = readApiKey();
  }
  if (!getEnvValue(["OPENAI_COMPAT_BASE_URL", "BAILIAN_COMPAT_BASE_URL", "DASHSCOPE_BASE_URL"])) {
    process.env.OPENAI_COMPAT_BASE_URL = DEFAULT_BASE_URL;
  }
  if (!getEnvValue(["OPENAI_COMPAT_MODEL", "BAILIAN_COMPAT_MODEL", "DASHSCOPE_MODEL"])) {
    process.env.OPENAI_COMPAT_MODEL = DEFAULT_MODEL;
  }
  if (
    !process.env.OPENAI_COMPAT_PROXY_URL &&
    !process.env.HTTPS_PROXY &&
    !process.env.HTTP_PROXY
  ) {
    const detectedProxy = detectWindowsProxyUrl();
    if (detectedProxy) {
      process.env.OPENAI_COMPAT_PROXY_URL = detectedProxy;
      process.env.HTTPS_PROXY = detectedProxy;
      process.env.HTTP_PROXY = detectedProxy;
    }
  }

  const provider = require("../cloudfunctions/queryPropertyRecommend/providers/openaiCompatible");

  const result = await provider.request(
    {
      query: "请用一句话总结：预算90万内，优先电梯，学区优先。",
      userId: "smoke_user",
      sessionId: "smoke_session",
      context: {
        active_intake: {
          city: "上饶",
          budget_max: 90
        },
        memory_profile: {
          elevator_required: true,
          school_priority: true
        }
      }
    },
    {
      traceId: `smoke_${Date.now()}`,
      startTime: Date.now(),
      buildErrorResult({ code, message, traceId, durationMs, details, mode }) {
        return {
          success: false,
          data: null,
          error: {
            code,
            message,
            details
          },
          meta: {
            trace_id: traceId,
            duration_ms: durationMs,
            mode
          }
        };
      }
    }
  );

  if (!result.success) {
    console.error("provider_smoke_failed", {
      code: result.error && result.error.code,
      message: result.error && result.error.message,
      details: result.error && result.error.details,
      mode: result.meta && result.meta.mode,
      proxy_enabled: Boolean(
        process.env.OPENAI_COMPAT_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
      ),
      base_url: getEnvValue(
        ["OPENAI_COMPAT_BASE_URL", "BAILIAN_COMPAT_BASE_URL", "DASHSCOPE_BASE_URL"],
        DEFAULT_BASE_URL
      ),
      model: getEnvValue(
        ["OPENAI_COMPAT_MODEL", "BAILIAN_COMPAT_MODEL", "DASHSCOPE_MODEL"],
        DEFAULT_MODEL
      )
    });
    process.exitCode = 1;
    return;
  }

  console.log("provider_smoke_ok", {
    type: result.type,
    summary: result.data && result.data.summary,
    proxy_enabled: Boolean(
      process.env.OPENAI_COMPAT_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY
    ),
    question_count: Array.isArray(result.data && result.data.questions)
      ? result.data.questions.length
      : 0,
    recommendation_count: Array.isArray(result.data && result.data.recommendations)
      ? result.data.recommendations.length
      : 0,
    base_url: getEnvValue(
      ["OPENAI_COMPAT_BASE_URL", "BAILIAN_COMPAT_BASE_URL", "DASHSCOPE_BASE_URL"],
      DEFAULT_BASE_URL
    ),
    model: getEnvValue(
      ["OPENAI_COMPAT_MODEL", "BAILIAN_COMPAT_MODEL", "DASHSCOPE_MODEL"],
      DEFAULT_MODEL
    )
  });
}

main().catch((err) => {
  console.error("provider_smoke_exception", err && err.message ? err.message : err);
  process.exitCode = 1;
});
