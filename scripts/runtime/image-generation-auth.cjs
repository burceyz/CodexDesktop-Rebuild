const API_KEY_ENV = "CODEX_REBUILD_IMAGE_GENERATION_API_KEY";
const ACTOR_HEADER = "x-openai-actor-authorization";
const ACTOR_HEADER_VALUE = "api-key";

function loadTomlParser() {
  try {
    return require("smol-toml").parse;
  } catch {
    return require("./codex-image-generation-toml.cjs").parse;
  }
}

function defaultRuntime() {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  return {
    env: process.env,
    homedir: () => os.homedir(),
    join: (...parts) => path.join(...parts),
    parseToml: loadTomlParser(),
    readFile: (file) => fs.readFileSync(file, "utf8"),
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isCustomBaseUrl(value) {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return !(
      hostname === "openai.com" ||
      hostname.endsWith(".openai.com") ||
      hostname === "chatgpt.com" ||
      hostname.endsWith(".chatgpt.com")
    );
  } catch {
    return false;
  }
}

function defaultModelCatalogUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function dottedKeySegment(value) {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function readJson(runtime, file) {
  return JSON.parse(runtime.readFile(file));
}

function hasConfiguredProviderAuth(provider, env) {
  if (provider.requires_openai_auth !== false) return false;
  if (
    isNonEmptyString(provider.env_key) &&
    isNonEmptyString(env[provider.env_key])
  ) {
    return true;
  }
  if (isNonEmptyString(provider.experimental_bearer_token)) return true;
  return provider.auth != null && typeof provider.auth === "object";
}

function addWslenvEntry(env, name) {
  const entries = isNonEmptyString(env.WSLENV)
    ? env.WSLENV.split(":").filter(Boolean)
    : [];
  const exists = entries.some(
    (entry) => entry.split("/", 1)[0].toUpperCase() === name.toUpperCase(),
  );
  if (!exists) env.WSLENV = [...entries, name].join(":");
}

function resolvePatch(runtime = defaultRuntime()) {
  try {
    const env = runtime.env;
    const configuredHome = isNonEmptyString(env.CODEX_HOME)
      ? env.CODEX_HOME.trim()
      : runtime.join(runtime.homedir(), ".codex");
    const config = runtime.parseToml(
      runtime.readFile(runtime.join(configuredHome, "config.toml")),
    );

    const providerId = config.model_provider;
    const provider = config.model_providers?.[providerId];
    if (!isNonEmptyString(providerId) || provider == null) return null;
    if (!isCustomBaseUrl(provider.base_url)) return null;
    if (provider.wire_api != null && provider.wire_api !== "responses") {
      return null;
    }

    const imageGenerationEnabled =
      config.features?.image_generation !== false;
    const modelDiscoveryEnabled =
      config.model_catalog_json == null &&
      config.features?.api_key_model_discovery !== false;
    if (!imageGenerationEnabled && !modelDiscoveryEnabled) return null;

    let needsEnvOverride = !hasConfiguredProviderAuth(provider, env);
    if (needsEnvOverride) {
      const auth = readJson(runtime, runtime.join(configuredHome, "auth.json"));
      const apiKey = auth.OPENAI_API_KEY;
      const authMode = String(auth.auth_mode ?? "")
        .trim()
        .toLowerCase()
        .replaceAll("_", "")
        .replaceAll("-", "");
      if (!isNonEmptyString(apiKey)) return null;
      if (authMode && authMode !== "apikey") return null;
      env[API_KEY_ENV] = apiKey.trim();
      addWslenvEntry(env, API_KEY_ENV);
    }

    const providerPath = `model_providers.${dottedKeySegment(providerId)}`;
    const overrides = [`${providerPath}.requires_openai_auth=false`];
    if (imageGenerationEnabled) {
      overrides.push(
        "features.image_generation=true",
        `${providerPath}.http_headers.${ACTOR_HEADER}=${JSON.stringify(ACTOR_HEADER_VALUE)}`,
      );
    }
    if (modelDiscoveryEnabled) {
      overrides.push("features.api_key_model_discovery=true");
      if (!isNonEmptyString(provider.model_catalog_url)) {
        overrides.push(
          `${providerPath}.model_catalog_url=${JSON.stringify(defaultModelCatalogUrl(provider.base_url))}`,
        );
      }
    }
    if (needsEnvOverride) {
      overrides.push(`${providerPath}.env_key=${JSON.stringify(API_KEY_ENV)}`);
    }

    return { overrides };
  } catch {
    // 配置、认证或 TOML 解析失败时保持上游行为，避免阻断 app-server 启动。
    return null;
  }
}

function withImageGenerationAuth(baseArgs, runtime) {
  const patch = resolvePatch(runtime);
  if (patch == null) return baseArgs;
  return [
    ...baseArgs,
    ...patch.overrides.flatMap((override) => ["-c", override]),
  ];
}

module.exports = {
  ACTOR_HEADER,
  ACTOR_HEADER_VALUE,
  API_KEY_ENV,
  defaultModelCatalogUrl,
  isCustomBaseUrl,
  resolvePatch,
  withImageGenerationAuth,
};
