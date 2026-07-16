/**
 * Generated from models.dev/api.json by scripts/sync-provider-manifest.mjs.
 * Do not hand-edit. Curated labels/defaults and native auth overrides live in
 * providers-catalog.ts and the engine provider registry respectively.
 */
export interface ProviderManifestEntry {
  id: string;
  name: string;
  env: readonly string[];
  baseURL: string;
  npm: string;
  defaultModel: string;
}

export const PROVIDER_MANIFEST: readonly ProviderManifestEntry[] = [
  {
    "id": "302ai",
    "name": "302.AI",
    "env": [
      "302AI_API_KEY"
    ],
    "baseURL": "https://api.302.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "chatgpt-4o-latest"
  },
  {
    "id": "abacus",
    "name": "Abacus",
    "env": [
      "ABACUS_API_KEY"
    ],
    "baseURL": "https://routellm.abacus.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-3-7-sonnet-20250219"
  },
  {
    "id": "abliteration-ai",
    "name": "abliteration.ai",
    "env": [
      "ABLIT_KEY"
    ],
    "baseURL": "https://api.abliteration.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "abliterated-model"
  },
  {
    "id": "ai-router",
    "name": "AI-ROUTER",
    "env": [
      "AI_ROUTER_API_KEY"
    ],
    "baseURL": "https://api.ai-router.dev/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "gpt-5.4"
  },
  {
    "id": "aihubmix",
    "name": "AIHubMix",
    "env": [
      "AIHUBMIX_API_KEY"
    ],
    "baseURL": "",
    "npm": "@aihubmix/ai-sdk-provider",
    "defaultModel": "alicloud-deepseek-v4-flash"
  },
  {
    "id": "alibaba",
    "name": "Alibaba",
    "env": [
      "DASHSCOPE_API_KEY"
    ],
    "baseURL": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "qvq-max"
  },
  {
    "id": "alibaba-cn",
    "name": "Alibaba (China)",
    "env": [
      "DASHSCOPE_API_KEY"
    ],
    "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-r1"
  },
  {
    "id": "alibaba-coding-plan",
    "name": "Alibaba Coding Plan",
    "env": [
      "ALIBABA_CODING_PLAN_API_KEY"
    ],
    "baseURL": "https://coding-intl.dashscope.aliyuncs.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "glm-4.7"
  },
  {
    "id": "alibaba-coding-plan-cn",
    "name": "Alibaba Coding Plan (China)",
    "env": [
      "ALIBABA_CODING_PLAN_API_KEY"
    ],
    "baseURL": "https://coding.dashscope.aliyuncs.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "glm-4.7"
  },
  {
    "id": "alibaba-token-plan",
    "name": "Alibaba Token Plan",
    "env": [
      "ALIBABA_TOKEN_PLAN_API_KEY"
    ],
    "baseURL": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-v3.2"
  },
  {
    "id": "alibaba-token-plan-cn",
    "name": "Alibaba Token Plan (China)",
    "env": [
      "ALIBABA_TOKEN_PLAN_API_KEY"
    ],
    "baseURL": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-v3.2"
  },
  {
    "id": "amazon-bedrock",
    "name": "Amazon Bedrock",
    "env": [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_BEARER_TOKEN_BEDROCK"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/amazon-bedrock",
    "defaultModel": "amazon.nova-2-lite-v1:0"
  },
  {
    "id": "ambient",
    "name": "Ambient",
    "env": [
      "AMBIENT_API_KEY"
    ],
    "baseURL": "https://api.ambient.xyz/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "ambient/large"
  },
  {
    "id": "anthropic",
    "name": "Anthropic",
    "env": [
      "ANTHROPIC_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/anthropic",
    "defaultModel": "claude-fable-5"
  },
  {
    "id": "anyapi",
    "name": "AnyAPI",
    "env": [
      "ANYAPI_API_KEY"
    ],
    "baseURL": "https://api.anyapi.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "anthropic/claude-haiku-4-5"
  },
  {
    "id": "atomic-chat",
    "name": "Atomic Chat",
    "env": [
      "ATOMIC_CHAT_API_KEY"
    ],
    "baseURL": "http://127.0.0.1:1337/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "gemma-4-E4B-it-IQ4_XS"
  },
  {
    "id": "auriko",
    "name": "Auriko",
    "env": [
      "AURIKO_API_KEY"
    ],
    "baseURL": "https://api.auriko.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-opus-4-6"
  },
  {
    "id": "azure",
    "name": "Azure",
    "env": [
      "AZURE_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/azure",
    "defaultModel": "claude-fable-5"
  },
  {
    "id": "azure-cognitive-services",
    "name": "Azure Cognitive Services",
    "env": [
      "AZURE_COGNITIVE_SERVICES_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/azure",
    "defaultModel": "claude-haiku-4-5"
  },
  {
    "id": "bailing",
    "name": "Bailing",
    "env": [
      "BAILING_API_TOKEN"
    ],
    "baseURL": "https://api.tbox.cn/api/llm/v1/chat/completions",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "Ling-1T"
  },
  {
    "id": "baseten",
    "name": "Baseten",
    "env": [
      "BASETEN_API_KEY"
    ],
    "baseURL": "https://inference.baseten.co/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-ai/DeepSeek-V4-Pro"
  },
  {
    "id": "berget",
    "name": "Berget.AI",
    "env": [
      "BERGET_API_KEY"
    ],
    "baseURL": "https://api.berget.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "google/gemma-4-31B-it"
  },
  {
    "id": "blueclaw",
    "name": "Blue Claw",
    "env": [
      "BLUECLAW_API_KEY"
    ],
    "baseURL": "https://openai.blueclaw.network/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "Qwen/Qwen3.6-35B-A3B-FP8"
  },
  {
    "id": "cerebras",
    "name": "Cerebras",
    "env": [
      "CEREBRAS_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/cerebras",
    "defaultModel": "gemma-4-31b"
  },
  {
    "id": "chutes",
    "name": "Chutes",
    "env": [
      "CHUTES_API_KEY"
    ],
    "baseURL": "https://llm.chutes.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-ai/DeepSeek-V3.2-TEE"
  },
  {
    "id": "clarifai",
    "name": "Clarifai",
    "env": [
      "CLARIFAI_PAT"
    ],
    "baseURL": "https://api.clarifai.com/v2/ext/openai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "arcee_ai/AFM/models/trinity-mini"
  },
  {
    "id": "claudinio",
    "name": "Claudinio",
    "env": [
      "CLAUDINIO_API_KEY"
    ],
    "baseURL": "https://api.claudin.io/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claudinio"
  },
  {
    "id": "cloudferro-sherlock",
    "name": "CloudFerro Sherlock",
    "env": [
      "CLOUDFERRO_SHERLOCK_API_KEY"
    ],
    "baseURL": "https://api-sherlock.cloudferro.com/openai/v1/",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "meta-llama/Llama-3.3-70B-Instruct"
  },
  {
    "id": "cloudflare-ai-gateway",
    "name": "Cloudflare AI Gateway",
    "env": [
      "CLOUDFLARE_API_TOKEN"
    ],
    "baseURL": "",
    "npm": "ai-gateway-provider",
    "defaultModel": "anthropic/claude-3-5-haiku"
  },
  {
    "id": "cloudflare-workers-ai",
    "name": "Cloudflare Workers AI",
    "env": [
      "CLOUDFLARE_API_KEY"
    ],
    "baseURL": "https://api.cloudflare.com/client/v4/accounts/\u0024{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "@cf/aisingapore/gemma-sea-lion-v4-27b-it"
  },
  {
    "id": "cohere",
    "name": "Cohere",
    "env": [
      "COHERE_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/cohere",
    "defaultModel": "c4ai-aya-expanse-32b"
  },
  {
    "id": "cortecs",
    "name": "Cortecs",
    "env": [
      "CORTECS_API_KEY"
    ],
    "baseURL": "https://api.cortecs.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-4-5-sonnet"
  },
  {
    "id": "crof",
    "name": "CrofAI",
    "env": [
      "CROF_API_KEY"
    ],
    "baseURL": "https://crof.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-v3.2"
  },
  {
    "id": "crossmodel",
    "name": "CrossModel",
    "env": [
      "CROSSMODEL_API_KEY"
    ],
    "baseURL": "https://api.crossmodel.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "anthropic/claude-fable-5"
  },
  {
    "id": "daoxe",
    "name": "DaoXE",
    "env": [
      "DAOXE_API_KEY"
    ],
    "baseURL": "https://daoxe.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-haiku-4-5-20251001"
  },
  {
    "id": "databricks",
    "name": "Databricks",
    "env": [
      "DATABRICKS_TOKEN"
    ],
    "baseURL": "https://\u0024{DATABRICKS_HOST}/ai-gateway/mlflow/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "databricks-claude-haiku-4-5"
  },
  {
    "id": "deepinfra",
    "name": "Deep Infra",
    "env": [
      "DEEPINFRA_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/deepinfra",
    "defaultModel": "deepseek-ai/DeepSeek-R1-0528"
  },
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "env": [
      "DEEPSEEK_API_KEY"
    ],
    "baseURL": "https://api.deepseek.com",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-chat"
  },
  {
    "id": "digitalocean",
    "name": "DigitalOcean",
    "env": [
      "DIGITALOCEAN_ACCESS_TOKEN"
    ],
    "baseURL": "https://inference.do-ai.run/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "alibaba-qwen3-32b"
  },
  {
    "id": "dinference",
    "name": "DInference",
    "env": [
      "DINFERENCE_API_KEY"
    ],
    "baseURL": "https://api.dinference.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "glm-4.7"
  },
  {
    "id": "drun",
    "name": "D.Run (China)",
    "env": [
      "DRUN_API_KEY"
    ],
    "baseURL": "https://chat.d.run/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "public/deepseek-r1"
  },
  {
    "id": "ebcloud",
    "name": "EBCloud",
    "env": [
      "EBCLOUD_API_KEY"
    ],
    "baseURL": "https://maas-api.ebcloud.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "DeepSeek-V4-Flash"
  },
  {
    "id": "empiriolabs",
    "name": "EmpirioLabs AI",
    "env": [
      "EMPIRIOLABS_API_KEY"
    ],
    "baseURL": "https://api.empiriolabs.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-v4-flash"
  },
  {
    "id": "evroc",
    "name": "evroc",
    "env": [
      "EVROC_API_KEY"
    ],
    "baseURL": "https://models.think.evroc.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "evroc/roc"
  },
  {
    "id": "fastrouter",
    "name": "FastRouter",
    "env": [
      "FASTROUTER_API_KEY"
    ],
    "baseURL": "https://go.fastrouter.ai/api/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "anthropic/claude-opus-4.1"
  },
  {
    "id": "fireworks-ai",
    "name": "Fireworks AI",
    "env": [
      "FIREWORKS_API_KEY"
    ],
    "baseURL": "https://api.fireworks.ai/inference/v1/",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "accounts/fireworks/models/deepseek-v4-flash"
  },
  {
    "id": "freemodel",
    "name": "FreeModel",
    "env": [
      "FREEMODEL_API_KEY"
    ],
    "baseURL": "https://cc.freemodel.dev/v1",
    "npm": "@ai-sdk/anthropic",
    "defaultModel": "claude-fable-5"
  },
  {
    "id": "friendli",
    "name": "Friendli",
    "env": [
      "FRIENDLI_TOKEN"
    ],
    "baseURL": "https://api.friendli.ai/serverless/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-ai/DeepSeek-V3.2"
  },
  {
    "id": "frogbot",
    "name": "FrogBot",
    "env": [
      "FROGBOT_API_KEY"
    ],
    "baseURL": "https://app.frogbot.ai/api/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-haiku-4-5"
  },
  {
    "id": "github-copilot",
    "name": "GitHub Copilot",
    "env": [
      "GITHUB_TOKEN"
    ],
    "baseURL": "https://api.githubcopilot.com",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-fable-5"
  },
  {
    "id": "github-models",
    "name": "GitHub Models",
    "env": [
      "GITHUB_TOKEN"
    ],
    "baseURL": "https://models.github.ai/inference",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "ai21-labs/ai21-jamba-1.5-large"
  },
  {
    "id": "gitlab",
    "name": "GitLab Duo",
    "env": [
      "GITLAB_TOKEN"
    ],
    "baseURL": "",
    "npm": "gitlab-ai-provider",
    "defaultModel": "duo-chat-fable-5"
  },
  {
    "id": "gmicloud",
    "name": "GMI Cloud",
    "env": [
      "GMICLOUD_API_KEY"
    ],
    "baseURL": "https://api.gmi-serving.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "anthropic/claude-opus-4.6"
  },
  {
    "id": "google",
    "name": "Google",
    "env": [
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GEMINI_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/google",
    "defaultModel": "gemini-2.5-flash"
  },
  {
    "id": "google-vertex",
    "name": "Vertex",
    "env": [
      "GOOGLE_VERTEX_PROJECT",
      "GOOGLE_VERTEX_LOCATION",
      "GOOGLE_APPLICATION_CREDENTIALS"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/google-vertex",
    "defaultModel": "claude-haiku-4-5@20251001"
  },
  {
    "id": "google-vertex-anthropic",
    "name": "Vertex (Anthropic)",
    "env": [
      "GOOGLE_VERTEX_PROJECT",
      "GOOGLE_VERTEX_LOCATION",
      "GOOGLE_APPLICATION_CREDENTIALS"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/google-vertex/anthropic",
    "defaultModel": "claude-haiku-4-5@20251001"
  },
  {
    "id": "groq",
    "name": "Groq",
    "env": [
      "GROQ_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/groq",
    "defaultModel": "canopylabs/orpheus-arabic-saudi"
  },
  {
    "id": "helicone",
    "name": "Helicone",
    "env": [
      "HELICONE_API_KEY"
    ],
    "baseURL": "https://ai-gateway.helicone.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "chatgpt-4o-latest"
  },
  {
    "id": "hpc-ai",
    "name": "HPC-AI",
    "env": [
      "HPC_AI_API_KEY"
    ],
    "baseURL": "https://api.hpc-ai.com/inference/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "anthropic/claude-opus-4.7"
  },
  {
    "id": "huggingface",
    "name": "Hugging Face",
    "env": [
      "HF_TOKEN"
    ],
    "baseURL": "https://router.huggingface.co/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-ai/DeepSeek-R1"
  },
  {
    "id": "iflowcn",
    "name": "iFlow",
    "env": [
      "IFLOW_API_KEY"
    ],
    "baseURL": "https://apis.iflow.cn/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-r1"
  },
  {
    "id": "inception",
    "name": "Inception",
    "env": [
      "INCEPTION_API_KEY"
    ],
    "baseURL": "https://api.inceptionlabs.ai/v1/",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "mercury-2"
  },
  {
    "id": "inceptron",
    "name": "Inceptron",
    "env": [
      "INCEPTRON_API_KEY"
    ],
    "baseURL": "https://api.inceptron.io/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "MiniMaxAI/MiniMax-M2.5"
  },
  {
    "id": "inference",
    "name": "Inference",
    "env": [
      "INFERENCE_API_KEY"
    ],
    "baseURL": "https://inference.net/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "google/gemma-3"
  },
  {
    "id": "inferx",
    "name": "InferX",
    "env": [
      "INFERX_API_KEY"
    ],
    "baseURL": "https://model.inferx.net/endpoints/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "google/gemma-4-31b-it-fp8"
  },
  {
    "id": "io-net",
    "name": "IO.NET",
    "env": [
      "IOINTELLIGENCE_API_KEY"
    ],
    "baseURL": "https://api.intelligence.io.solutions/api/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-ai/DeepSeek-R1-0528"
  },
  {
    "id": "jiekou",
    "name": "Jiekou.AI",
    "env": [
      "JIEKOU_API_KEY"
    ],
    "baseURL": "https://api.jiekou.ai/openai",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "baidu/ernie-4.5-300b-a47b-paddle"
  },
  {
    "id": "kenari",
    "name": "Kenari",
    "env": [
      "KENARI_API_KEY"
    ],
    "baseURL": "https://kenari.id/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-opus-4-7"
  },
  {
    "id": "kilo",
    "name": "Kilo Gateway",
    "env": [
      "KILO_API_KEY"
    ],
    "baseURL": "https://api.kilo.ai/api/gateway",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "~anthropic/claude-haiku-latest"
  },
  {
    "id": "kimi-for-coding",
    "name": "Kimi For Coding",
    "env": [
      "KIMI_API_KEY"
    ],
    "baseURL": "https://api.kimi.com/coding/v1",
    "npm": "@ai-sdk/anthropic",
    "defaultModel": "k2p5"
  },
  {
    "id": "kuae-cloud-coding-plan",
    "name": "KUAE Cloud Coding Plan",
    "env": [
      "KUAE_API_KEY"
    ],
    "baseURL": "https://coding-plan-endpoint.kuaecloud.net/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "GLM-4.7"
  },
  {
    "id": "lilac",
    "name": "Lilac",
    "env": [
      "LILAC_API_KEY"
    ],
    "baseURL": "https://api.getlilac.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "google/gemma-4-31b-it"
  },
  {
    "id": "llama",
    "name": "Llama",
    "env": [
      "LLAMA_API_KEY"
    ],
    "baseURL": "https://api.llama.com/compat/v1/",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "cerebras-llama-4-maverick-17b-128e-instruct"
  },
  {
    "id": "llmgateway",
    "name": "LLM Gateway",
    "env": [
      "LLMGATEWAY_API_KEY"
    ],
    "baseURL": "https://api.llmgateway.io/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "auto"
  },
  {
    "id": "llmtr",
    "name": "LLMTR",
    "env": [
      "LLMTR_API_KEY"
    ],
    "baseURL": "https://llmtr.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "gemma-4"
  },
  {
    "id": "lmstudio",
    "name": "LMStudio",
    "env": [
      "LMSTUDIO_API_KEY"
    ],
    "baseURL": "http://127.0.0.1:1234/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "openai/gpt-oss-20b"
  },
  {
    "id": "longcat",
    "name": "LongCat",
    "env": [
      "LONGCAT_API_KEY"
    ],
    "baseURL": "https://api.longcat.chat/openai",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "LongCat-2.0"
  },
  {
    "id": "lucidquery",
    "name": "LucidQuery",
    "env": [
      "LUCIDQUERY_API_KEY"
    ],
    "baseURL": "https://api.lucidquery.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "lucidnova-rf1-100b"
  },
  {
    "id": "lynkr",
    "name": "Lynkr",
    "env": [
      "LYNKR_API_KEY"
    ],
    "baseURL": "http://127.0.0.1:8081/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "lynkr-auto"
  },
  {
    "id": "meganova",
    "name": "Meganova",
    "env": [
      "MEGANOVA_API_KEY"
    ],
    "baseURL": "https://api.meganova.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-ai/DeepSeek-R1-0528"
  },
  {
    "id": "merge-gateway",
    "name": "Merge Gateway",
    "env": [
      "MERGE_GATEWAY_API_KEY"
    ],
    "baseURL": "",
    "npm": "merge-gateway-ai-sdk-provider",
    "defaultModel": "alibaba/qwen3.6-plus"
  },
  {
    "id": "meta",
    "name": "Meta",
    "env": [
      "META_MODEL_API_KEY"
    ],
    "baseURL": "https://api.meta.ai/v1",
    "npm": "@ai-sdk/openai",
    "defaultModel": "muse-spark-1.1"
  },
  {
    "id": "minimax",
    "name": "MiniMax (minimax.io)",
    "env": [
      "MINIMAX_API_KEY"
    ],
    "baseURL": "https://api.minimax.io/anthropic/v1",
    "npm": "@ai-sdk/anthropic",
    "defaultModel": "MiniMax-M2"
  },
  {
    "id": "minimax-cn",
    "name": "MiniMax (minimaxi.com)",
    "env": [
      "MINIMAX_API_KEY"
    ],
    "baseURL": "https://api.minimaxi.com/anthropic/v1",
    "npm": "@ai-sdk/anthropic",
    "defaultModel": "MiniMax-M2"
  },
  {
    "id": "minimax-cn-coding-plan",
    "name": "MiniMax Token Plan (minimaxi.com)",
    "env": [
      "MINIMAX_API_KEY"
    ],
    "baseURL": "https://api.minimaxi.com/anthropic/v1",
    "npm": "@ai-sdk/anthropic",
    "defaultModel": "MiniMax-M2"
  },
  {
    "id": "minimax-coding-plan",
    "name": "MiniMax Token Plan (minimax.io)",
    "env": [
      "MINIMAX_API_KEY"
    ],
    "baseURL": "https://api.minimax.io/anthropic/v1",
    "npm": "@ai-sdk/anthropic",
    "defaultModel": "MiniMax-M2"
  },
  {
    "id": "mistral",
    "name": "Mistral",
    "env": [
      "MISTRAL_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/mistral",
    "defaultModel": "codestral-latest"
  },
  {
    "id": "mixlayer",
    "name": "Mixlayer",
    "env": [
      "MIXLAYER_API_KEY"
    ],
    "baseURL": "https://models.mixlayer.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "qwen/qwen3.5-122b-a10b"
  },
  {
    "id": "moark",
    "name": "Moark",
    "env": [
      "MOARK_API_KEY"
    ],
    "baseURL": "https://moark.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "GLM-4.7"
  },
  {
    "id": "model-oracle-ai",
    "name": "Model Oracle AI",
    "env": [
      "MODEL_ORACLE_API_KEY"
    ],
    "baseURL": "https://api.modeloracle.com/api/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "auto"
  },
  {
    "id": "modelscope",
    "name": "ModelScope",
    "env": [
      "MODELSCOPE_API_KEY"
    ],
    "baseURL": "https://api-inference.modelscope.cn/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "Qwen/Qwen3-235B-A22B-Instruct-2507"
  },
  {
    "id": "moonshotai",
    "name": "Moonshot AI",
    "env": [
      "MOONSHOT_API_KEY"
    ],
    "baseURL": "https://api.moonshot.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "kimi-k2-0711-preview"
  },
  {
    "id": "moonshotai-cn",
    "name": "Moonshot AI (China)",
    "env": [
      "MOONSHOT_API_KEY"
    ],
    "baseURL": "https://api.moonshot.cn/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "kimi-k2-0711-preview"
  },
  {
    "id": "morph",
    "name": "Morph",
    "env": [
      "MORPH_API_KEY"
    ],
    "baseURL": "https://api.morphllm.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "auto"
  },
  {
    "id": "nano-gpt",
    "name": "NanoGPT",
    "env": [
      "NANO_GPT_API_KEY"
    ],
    "baseURL": "https://nano-gpt.com/api/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "abacusai/Dracarys-72B-Instruct"
  },
  {
    "id": "nearai",
    "name": "NEAR AI Cloud",
    "env": [
      "NEARAI_API_KEY"
    ],
    "baseURL": "https://cloud-api.near.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "anthropic/claude-haiku-4-5"
  },
  {
    "id": "nebius",
    "name": "Nebius Token Factory",
    "env": [
      "NEBIUS_API_KEY"
    ],
    "baseURL": "https://api.tokenfactory.nebius.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-ai/DeepSeek-V4-Pro"
  },
  {
    "id": "neon",
    "name": "Neon",
    "env": [
      "NEON_AI_GATEWAY_TOKEN"
    ],
    "baseURL": "\u0024{NEON_AI_GATEWAY_BASE_URL}/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-haiku-4-5"
  },
  {
    "id": "neuralwatt",
    "name": "Neuralwatt",
    "env": [
      "NEURALWATT_API_KEY"
    ],
    "baseURL": "https://api.neuralwatt.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "glm-5.2"
  },
  {
    "id": "nova",
    "name": "Nova",
    "env": [
      "NOVA_API_KEY"
    ],
    "baseURL": "https://api.nova.amazon.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "nova-2-lite-v1"
  },
  {
    "id": "novita-ai",
    "name": "NovitaAI",
    "env": [
      "NOVITA_API_KEY"
    ],
    "baseURL": "https://api.novita.ai/openai",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "baichuan/baichuan-m2-32b"
  },
  {
    "id": "nvidia",
    "name": "Nvidia",
    "env": [
      "NVIDIA_API_KEY"
    ],
    "baseURL": "https://integrate.api.nvidia.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "abacusai/dracarys-llama-3_1-70b-instruct"
  },
  {
    "id": "ollama-cloud",
    "name": "Ollama Cloud",
    "env": [
      "OLLAMA_API_KEY"
    ],
    "baseURL": "https://ollama.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-v4-flash"
  },
  {
    "id": "openai",
    "name": "OpenAI",
    "env": [
      "OPENAI_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/openai",
    "defaultModel": "chatgpt-image-latest"
  },
  {
    "id": "opencode",
    "name": "OpenCode Zen",
    "env": [
      "OPENCODE_API_KEY"
    ],
    "baseURL": "https://opencode.ai/zen/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "big-pickle"
  },
  {
    "id": "opencode-go",
    "name": "OpenCode Go",
    "env": [
      "OPENCODE_API_KEY"
    ],
    "baseURL": "https://opencode.ai/zen/go/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-v4-flash"
  },
  {
    "id": "openrouter",
    "name": "OpenRouter",
    "env": [
      "OPENROUTER_API_KEY"
    ],
    "baseURL": "https://openrouter.ai/api/v1",
    "npm": "@openrouter/ai-sdk-provider",
    "defaultModel": "~anthropic/claude-fable-latest"
  },
  {
    "id": "orcarouter",
    "name": "OrcaRouter",
    "env": [
      "ORCAROUTER_API_KEY"
    ],
    "baseURL": "https://api.orcarouter.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "anthropic/claude-haiku-4.5"
  },
  {
    "id": "ovhcloud",
    "name": "OVHcloud AI Endpoints",
    "env": [
      "OVHCLOUD_API_KEY"
    ],
    "baseURL": "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "gpt-oss-120b"
  },
  {
    "id": "perplexity",
    "name": "Perplexity",
    "env": [
      "PERPLEXITY_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/perplexity",
    "defaultModel": "sonar"
  },
  {
    "id": "perplexity-agent",
    "name": "Perplexity Agent",
    "env": [
      "PERPLEXITY_API_KEY"
    ],
    "baseURL": "https://api.perplexity.ai/v1",
    "npm": "@ai-sdk/openai",
    "defaultModel": "anthropic/claude-haiku-4-5"
  },
  {
    "id": "pioneer",
    "name": "Pioneer",
    "env": [
      "PIONEER_API_KEY"
    ],
    "baseURL": "https://api.pioneer.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-haiku-4-5"
  },
  {
    "id": "poe",
    "name": "Poe",
    "env": [
      "POE_API_KEY"
    ],
    "baseURL": "https://api.poe.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "anthropic/claude-haiku-3"
  },
  {
    "id": "poolside",
    "name": "Poolside",
    "env": [
      "POOLSIDE_API_KEY"
    ],
    "baseURL": "https://inference.poolside.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "poolside/laguna-m.1"
  },
  {
    "id": "privatemode-ai",
    "name": "Privatemode AI",
    "env": [
      "PRIVATEMODE_API_KEY"
    ],
    "baseURL": "http://localhost:8080/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "gpt-oss-120b"
  },
  {
    "id": "qihang-ai",
    "name": "QiHang",
    "env": [
      "QIHANG_API_KEY"
    ],
    "baseURL": "https://api.qhaigc.net/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-haiku-4-5-20251001"
  },
  {
    "id": "qiniu-ai",
    "name": "Qiniu",
    "env": [
      "QINIU_API_KEY"
    ],
    "baseURL": "https://api.qnaigc.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-3.5-haiku"
  },
  {
    "id": "regolo-ai",
    "name": "Regolo AI",
    "env": [
      "REGOLO_API_KEY"
    ],
    "baseURL": "https://api.regolo.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "gpt-oss-120b"
  },
  {
    "id": "requesty",
    "name": "Requesty",
    "env": [
      "REQUESTY_API_KEY"
    ],
    "baseURL": "https://router.requesty.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "anthropic/claude-3-7-sonnet"
  },
  {
    "id": "routing-run",
    "name": "routing.run",
    "env": [
      "ROUTING_RUN_API_KEY"
    ],
    "baseURL": "https://api.routing.run/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-opus-4-8"
  },
  {
    "id": "sakana",
    "name": "Sakana AI",
    "env": [
      "SAKANA_API_KEY"
    ],
    "baseURL": "https://api.sakana.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "fugu"
  },
  {
    "id": "sap-ai-core",
    "name": "SAP AI Core",
    "env": [
      "AICORE_SERVICE_KEY"
    ],
    "baseURL": "",
    "npm": "@jerome-benoit/sap-ai-provider-v2",
    "defaultModel": "amazon--nova-lite"
  },
  {
    "id": "sarvam",
    "name": "Sarvam AI",
    "env": [
      "SARVAM_API_KEY"
    ],
    "baseURL": "https://api.sarvam.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "sarvam-105b"
  },
  {
    "id": "scaleway",
    "name": "Scaleway",
    "env": [
      "SCALEWAY_API_KEY"
    ],
    "baseURL": "https://api.scaleway.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "bge-multilingual-gemma2"
  },
  {
    "id": "siliconflow",
    "name": "SiliconFlow",
    "env": [
      "SILICONFLOW_API_KEY"
    ],
    "baseURL": "https://api.siliconflow.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "baidu/ERNIE-4.5-300B-A47B"
  },
  {
    "id": "siliconflow-cn",
    "name": "SiliconFlow (China)",
    "env": [
      "SILICONFLOW_CN_API_KEY"
    ],
    "baseURL": "https://api.siliconflow.cn/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "baidu/ERNIE-4.5-300B-A47B"
  },
  {
    "id": "snowflake-cortex",
    "name": "Snowflake Cortex",
    "env": [
      "SNOWFLAKE_CORTEX_PAT"
    ],
    "baseURL": "https://\u0024{SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-fable-5"
  },
  {
    "id": "stackit",
    "name": "STACKIT",
    "env": [
      "STACKIT_API_KEY"
    ],
    "baseURL": "https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "cortecs/Llama-3.3-70B-Instruct-FP8-Dynamic"
  },
  {
    "id": "stepfun",
    "name": "StepFun (China)",
    "env": [
      "STEPFUN_API_KEY"
    ],
    "baseURL": "https://api.stepfun.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "step-1-32k"
  },
  {
    "id": "stepfun-ai",
    "name": "StepFun (Global)",
    "env": [
      "STEPFUN_API_KEY"
    ],
    "baseURL": "https://api.stepfun.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "step-1-32k"
  },
  {
    "id": "stepfun-ai-step-plan",
    "name": "StepFun Step Plan (Global)",
    "env": [
      "STEPFUN_API_KEY"
    ],
    "baseURL": "https://api.stepfun.ai/step_plan/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "step-3.5-flash"
  },
  {
    "id": "stepfun-step-plan",
    "name": "StepFun Step Plan (China)",
    "env": [
      "STEPFUN_API_KEY"
    ],
    "baseURL": "https://api.stepfun.com/step_plan/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "step-3.5-flash"
  },
  {
    "id": "subconscious",
    "name": "Subconscious",
    "env": [
      "SUBCONSCIOUS_API_KEY"
    ],
    "baseURL": "https://api.subconscious.dev/v1",
    "npm": "@ai-sdk/anthropic",
    "defaultModel": "subconscious/glm-5.2"
  },
  {
    "id": "submodel",
    "name": "submodel",
    "env": [
      "SUBMODEL_INSTAGEN_ACCESS_KEY"
    ],
    "baseURL": "https://llm.submodel.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-ai/DeepSeek-R1-0528"
  },
  {
    "id": "synthetic",
    "name": "Synthetic",
    "env": [
      "SYNTHETIC_API_KEY"
    ],
    "baseURL": "https://api.synthetic.new/openai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "hf:MiniMaxAI/MiniMax-M3"
  },
  {
    "id": "tencent-coding-plan",
    "name": "Tencent Coding Plan (China)",
    "env": [
      "TENCENT_CODING_PLAN_API_KEY"
    ],
    "baseURL": "https://api.lkeap.cloud.tencent.com/coding/v3",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "glm-5"
  },
  {
    "id": "tencent-token-plan",
    "name": "Tencent Token Plan",
    "env": [
      "TENCENT_TOKEN_PLAN_API_KEY"
    ],
    "baseURL": "https://api.lkeap.cloud.tencent.com/plan/v3",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "hy3"
  },
  {
    "id": "tencent-tokenhub",
    "name": "Tencent TokenHub",
    "env": [
      "TENCENT_TOKENHUB_API_KEY"
    ],
    "baseURL": "https://tokenhub.tencentmaas.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "hy3"
  },
  {
    "id": "the-grid-ai",
    "name": "The Grid AI",
    "env": [
      "THEGRIDAI_API_KEY"
    ],
    "baseURL": "https://api.thegrid.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "agent-max"
  },
  {
    "id": "tinfoil",
    "name": "Tinfoil",
    "env": [
      "TINFOIL_API_KEY"
    ],
    "baseURL": "https://inference.tinfoil.sh/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "gemma4-31b"
  },
  {
    "id": "togetherai",
    "name": "Together AI",
    "env": [
      "TOGETHER_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/togetherai",
    "defaultModel": "deepcogito/cogito-v2-1-671b"
  },
  {
    "id": "trustedrouter",
    "name": "TrustedRouter",
    "env": [
      "TRUSTEDROUTER_API_KEY"
    ],
    "baseURL": "https://api.trustedrouter.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "auto"
  },
  {
    "id": "umans-ai",
    "name": "Umans AI",
    "env": [
      "UMANS_AI_API_KEY"
    ],
    "baseURL": "https://api.code.umans.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "umans-coder"
  },
  {
    "id": "umans-ai-coding-plan",
    "name": "Umans AI Coding Plan",
    "env": [
      "UMANS_AI_CODING_PLAN_API_KEY"
    ],
    "baseURL": "https://api.code.umans.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "umans-coder"
  },
  {
    "id": "unorouter",
    "name": "UnoRouter",
    "env": [
      "UNOROUTER_API_KEY"
    ],
    "baseURL": "https://api.unorouter.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-haiku-4-5-20251001"
  },
  {
    "id": "upstage",
    "name": "Upstage",
    "env": [
      "UPSTAGE_API_KEY"
    ],
    "baseURL": "https://api.upstage.ai/v1/solar",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "solar-mini"
  },
  {
    "id": "v0",
    "name": "v0",
    "env": [
      "V0_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/vercel",
    "defaultModel": "v0-1.0-md"
  },
  {
    "id": "venice",
    "name": "Venice AI",
    "env": [
      "VENICE_API_KEY"
    ],
    "baseURL": "",
    "npm": "venice-ai-sdk-provider",
    "defaultModel": "aion-labs-aion-3-0"
  },
  {
    "id": "vercel",
    "name": "Vercel AI Gateway",
    "env": [
      "AI_GATEWAY_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/gateway",
    "defaultModel": "alibaba/qwen-3-14b"
  },
  {
    "id": "vivgrid",
    "name": "Vivgrid",
    "env": [
      "VIVGRID_API_KEY"
    ],
    "baseURL": "https://api.vivgrid.com/v1",
    "npm": "@ai-sdk/openai",
    "defaultModel": "deepseek-v3.2"
  },
  {
    "id": "vultr",
    "name": "Vultr",
    "env": [
      "VULTR_API_KEY"
    ],
    "baseURL": "https://api.vultrinference.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-ai/DeepSeek-V4-Flash"
  },
  {
    "id": "wafer.ai",
    "name": "Wafer",
    "env": [
      "WAFER_API_KEY"
    ],
    "baseURL": "https://pass.wafer.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "GLM-5.1"
  },
  {
    "id": "wandb",
    "name": "Weights & Biases",
    "env": [
      "WANDB_API_KEY"
    ],
    "baseURL": "https://api.inference.wandb.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "deepseek-ai/DeepSeek-V3.1"
  },
  {
    "id": "xai",
    "name": "xAI",
    "env": [
      "XAI_API_KEY"
    ],
    "baseURL": "",
    "npm": "@ai-sdk/xai",
    "defaultModel": "grok-4.20-0309-non-reasoning"
  },
  {
    "id": "xiaomi",
    "name": "Xiaomi",
    "env": [
      "XIAOMI_API_KEY"
    ],
    "baseURL": "https://api.xiaomimimo.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "mimo-v2.5"
  },
  {
    "id": "xiaomi-token-plan-ams",
    "name": "Xiaomi Token Plan (Europe)",
    "env": [
      "XIAOMI_API_KEY"
    ],
    "baseURL": "https://token-plan-ams.xiaomimimo.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "mimo-v2-tts"
  },
  {
    "id": "xiaomi-token-plan-cn",
    "name": "Xiaomi Token Plan (China)",
    "env": [
      "XIAOMI_API_KEY"
    ],
    "baseURL": "https://token-plan-cn.xiaomimimo.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "mimo-v2-tts"
  },
  {
    "id": "xiaomi-token-plan-sgp",
    "name": "Xiaomi Token Plan (Singapore)",
    "env": [
      "XIAOMI_API_KEY"
    ],
    "baseURL": "https://token-plan-sgp.xiaomimimo.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "mimo-v2-tts"
  },
  {
    "id": "xpersona",
    "name": "Xpersona",
    "env": [
      "XPERSONA_API_KEY"
    ],
    "baseURL": "https://www.xpersona.co/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "claude-fable-5"
  },
  {
    "id": "zai",
    "name": "Z.AI",
    "env": [
      "ZHIPU_API_KEY"
    ],
    "baseURL": "https://api.z.ai/api/paas/v4",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "glm-4.5"
  },
  {
    "id": "zai-coding-plan",
    "name": "Z.AI Coding Plan",
    "env": [
      "ZHIPU_API_KEY"
    ],
    "baseURL": "https://api.z.ai/api/coding/paas/v4",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "glm-4.5-air"
  },
  {
    "id": "zeldoc",
    "name": "Zeldoc",
    "env": [
      "ZELDOC_API_KEY"
    ],
    "baseURL": "https://api.zeldoc.ai/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "z-code"
  },
  {
    "id": "zenifra",
    "name": "Zenifra",
    "env": [
      "ZENIFRA_AI_KEY"
    ],
    "baseURL": "https://ai.zenifra.com/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "alibaba/qwen3.6-35b-a3b"
  },
  {
    "id": "zenmux",
    "name": "ZenMux",
    "env": [
      "ZENMUX_API_KEY"
    ],
    "baseURL": "https://zenmux.ai/api/v1",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "anthropic/claude-3.5-haiku"
  },
  {
    "id": "zhipuai",
    "name": "Zhipu AI",
    "env": [
      "ZHIPU_API_KEY"
    ],
    "baseURL": "https://open.bigmodel.cn/api/paas/v4",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "glm-4.5"
  },
  {
    "id": "zhipuai-coding-plan",
    "name": "Zhipu AI Coding Plan",
    "env": [
      "ZHIPU_API_KEY"
    ],
    "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4",
    "npm": "@ai-sdk/openai-compatible",
    "defaultModel": "glm-4.5-air"
  }
] as const;
