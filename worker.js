// =================================================================================
//  项目: joycaption-2api (Cloudflare Worker 单文件版)
//  版本: 1.1.1 (代号: Visionary Stable - 稳定修复版)
//  作者: 首席AI执行官
//  日期: 2025-11-28
//
//  [v1.1.1 关键修复]
//  1. [Bug修复] 修复 "currentContent.substring is not a function" 错误。
//     - 原因: 上游 Gradio 在生成的初始阶段可能返回 null 或非字符串数据。
//     - 解决: 增加了严格的类型检查和空值安全处理 (Safe String Conversion)。
//  2. [核心优化] 移除了所有 FileReader 依赖，完全使用 ArrayBuffer 处理图片，兼容 CF Worker 环境。
//  3. [体验增强] Web UI 增加了更详细的错误提示和状态反馈。
// =================================================================================

// --- [第一部分: 核心配置] ---
const CONFIG = {
  PROJECT_NAME: "joycaption-2api",
  PROJECT_VERSION: "1.1.1",

  // 安全配置 (建议在 Cloudflare 环境变量中设置)
  API_MASTER_KEY: "1",

  // 上游服务配置 (JoyCaption Beta One)
  UPSTREAM_ORIGIN: "https://fancyfeast-joy-caption-beta-one.hf.space",
  
  // 伪装头
  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",

  // 模型列表
  MODELS: [
    "joy-caption-beta",
    "gpt-4-vision-preview", // 兼容性映射
    "gpt-4o"                // 兼容性映射
  ],
  DEFAULT_MODEL: "joy-caption-beta",

  // Gradio 配置
  FN_INDEX: 5, // chat_joycaption 函数索引
};

// --- [第二部分: Worker 入口] ---
export default {
  async fetch(request, env, ctx) {
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
    request.ctx = { apiKey };
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return handleCorsPreflight();
    if (url.pathname === '/') return handleUI(request);
    if (url.pathname.startsWith('/v1/')) return handleApi(request);
    
    return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
  }
};

// --- [第三部分: 核心逻辑] ---

// 1. API 路由分发
async function handleApi(request) {
  if (!verifyAuth(request)) return createErrorResponse('无效的 API Key', 401, 'unauthorized');

  const url = new URL(request.url);
  const requestId = `req-${crypto.randomUUID()}`;

  if (url.pathname === '/v1/models') return handleModelsRequest();
  if (url.pathname === '/v1/chat/completions') return handleChatCompletions(request, requestId);
  
  return createErrorResponse('不支持的 API 路径', 404, 'not_found');
}

// 2. 鉴权
function verifyAuth(request) {
  const authHeader = request.headers.get('Authorization');
  const validKey = request.ctx.apiKey;
  if (validKey === "1") return true; 
  return authHeader && authHeader === `Bearer ${validKey}`;
}

// 3. 模型列表
function handleModelsRequest() {
  return new Response(JSON.stringify({
    object: 'list',
    data: CONFIG.MODELS.map(id => ({
      id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'joycaption'
    }))
  }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
}

// 4. 辅助工具：ArrayBuffer 转 Base64 (替代 FileReader)
function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// 5. Gradio 客户端 (核心逆向逻辑)
class GradioClient {
    constructor() {
        this.sessionHash = Math.random().toString(36).substring(2);
    }

    // 上传文件 (手动构建 multipart/form-data)
    async uploadFile(base64Data, filename = "image.png") {
        const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
        
        // Base64 解码为二进制
        const byteString = atob(base64Data.split(',')[1]);
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i);
        }
        
        // 构建 Multipart Body
        let header = `--${boundary}\r\n`;
        header += `Content-Disposition: form-data; name="files"; filename="${filename}"\r\n`;
        header += `Content-Type: image/png\r\n\r\n`;
        
        const footer = `\r\n--${boundary}--\r\n`;
        
        const headerBytes = new TextEncoder().encode(header);
        const footerBytes = new TextEncoder().encode(footer);
        const fileBytes = new Uint8Array(ab);
        
        const combinedBuffer = new Uint8Array(headerBytes.length + fileBytes.length + footerBytes.length);
        combinedBuffer.set(headerBytes);
        combinedBuffer.set(fileBytes, headerBytes.length);
        combinedBuffer.set(footerBytes, headerBytes.length + fileBytes.length);

        const res = await fetch(`${CONFIG.UPSTREAM_ORIGIN}/gradio_api/upload`, {
            method: "POST",
            headers: {
                "Content-Type": `multipart/form-data; boundary=${boundary}`,
                "User-Agent": CONFIG.USER_AGENT
            },
            body: combinedBuffer
        });

        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const data = await res.json();
        // 返回格式通常是 ["/tmp/gradio/..."]
        return data[0];
    }

    // 加入队列
    async joinQueue(imagePath, prompt) {
        const payload = {
            data: [
                { path: imagePath, meta: { _type: "gradio.FileData" } }, // Input Image
                prompt || "Write a long detailed description for this image.", // Prompt
                0.6, // Temperature
                0.9, // Top-p
                512, // Max tokens
                true // Log prompt
            ],
            event_data: null,
            fn_index: CONFIG.FN_INDEX,
            trigger_id: null,
            session_hash: this.sessionHash
        };

        const res = await fetch(`${CONFIG.UPSTREAM_ORIGIN}/gradio_api/queue/join?`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "User-Agent": CONFIG.USER_AGENT },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error(`Join queue failed: ${res.status}`);
    }

    // 监听 SSE 流
    async *streamResponse() {
        const res = await fetch(`${CONFIG.UPSTREAM_ORIGIN}/gradio_api/queue/data?session_hash=${this.sessionHash}`, {
            headers: { "Accept": "text/event-stream", "User-Agent": CONFIG.USER_AGENT }
        });

        if (!res.ok) throw new Error(`SSE connection failed: ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop(); 

            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    try {
                        const json = JSON.parse(line.substring(6));
                        yield json;
                    } catch (e) { /* 忽略心跳包或无效JSON */ }
                }
            }
        }
    }
}

// 6. 聊天补全处理 (核心业务)
async function handleChatCompletions(request, requestId) {
    try {
        const body = await request.json();
        const messages = body.messages || [];
        const lastMsg = messages.reverse().find(m => m.role === 'user');
        if (!lastMsg) throw new Error("未找到用户消息");

        // 提取图片和提示词
        let imageUrl = null;
        let prompt = "";

        // 兼容 OpenAI Vision 格式
        if (Array.isArray(lastMsg.content)) {
            for (const part of lastMsg.content) {
                if (part.type === 'image_url') {
                    imageUrl = part.image_url.url;
                } else if (part.type === 'text') {
                    prompt += part.text;
                }
            }
        } else {
            // 兼容纯文本中的 URL
            const urlMatch = lastMsg.content.match(/https?:\/\/[^\s]+|data:image\/[a-z]+;base64,[^\s]+/);
            if (urlMatch) imageUrl = urlMatch[0];
            prompt = lastMsg.content.replace(imageUrl || "", "").trim();
        }

        if (!imageUrl) throw new Error("请在消息中提供图片 (Base64 或 URL)");

        const client = new GradioClient();
        
        // 步骤 A: 处理图片 (下载 URL 或直接使用 Base64)
        let base64Image;
        if (imageUrl.startsWith("data:image")) {
            base64Image = imageUrl;
        } else {
            // Worker 端下载图片并转 Base64 (修复 FileReader 问题)
            const imgRes = await fetch(imageUrl, { headers: { "User-Agent": CONFIG.USER_AGENT } });
            if (!imgRes.ok) throw new Error(`无法下载图片: ${imgRes.status}`);
            const imgBuffer = await imgRes.arrayBuffer();
            const contentType = imgRes.headers.get("content-type") || "image/png";
            base64Image = `data:${contentType};base64,${arrayBufferToBase64(imgBuffer)}`;
        }

        // 步骤 B: 上传到 HuggingFace
        const upstreamPath = await client.uploadFile(base64Image);

        // 步骤 C: 提交任务
        await client.joinQueue(upstreamPath, prompt);

        // 步骤 D: 流式响应
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        (async () => {
            try {
                let lastContent = "";
                for await (const msg of client.streamResponse()) {
                    if (msg.msg === "process_generating" || msg.msg === "process_completed") {
                        // [关键修复] 安全获取内容，防止 null/undefined 导致 substring 报错
                        let rawContent = msg.output?.data?.[0];
                        
                        // 强制转换为字符串，如果为 null/undefined 则转为空字符串
                        let currentContent = (typeof rawContent === 'string') ? rawContent : "";
                        
                        if (currentContent.length > lastContent.length) {
                            const delta = currentContent.substring(lastContent.length);
                            lastContent = currentContent;
                            
                            const chunk = {
                                id: requestId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: body.model || CONFIG.DEFAULT_MODEL,
                                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
                            };
                            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                        }

                        if (msg.msg === "process_completed") {
                            const endChunk = {
                                id: requestId,
                                object: 'chat.completion.chunk',
                                created: Math.floor(Date.now() / 1000),
                                model: body.model || CONFIG.DEFAULT_MODEL,
                                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
                            };
                            await writer.write(encoder.encode(`data: ${JSON.stringify(endChunk)}\n\n`));
                            await writer.write(encoder.encode('data: [DONE]\n\n'));
                            break;
                        }
                    }
                }
            } catch (e) {
                const errChunk = {
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: body.model,
                    choices: [{ index: 0, delta: { content: `\n\n[Error: ${e.message}]` }, finish_reason: 'error' }]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
            } finally {
                await writer.close();
            }
        })();

        return new Response(readable, {
            headers: corsHeaders({ 'Content-Type': 'text/event-stream' })
        });

    } catch (e) {
        return createErrorResponse(e.message, 500, 'internal_error');
    }
}

// --- [第四部分: 辅助函数] ---
function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第五部分: 开发者驾驶舱 UI (Web UI)] ---
function handleUI(request) {
  const origin = new URL(request.url).origin;
  const apiKey = request.ctx.apiKey;
  
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      :root { 
        --bg: #121212; --panel: #1E1E1E; --border: #333; --text: #E0E0E0; 
        --primary: #FFBF00; --primary-hover: #FFD700; --input-bg: #2A2A2A; 
        --success: #66BB6A; --error: #CF6679;
      }
      body { font-family: 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); margin: 0; height: 100vh; display: flex; overflow: hidden; }
      
      .sidebar { width: 350px; background: var(--panel); border-right: 1px solid var(--border); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; flex-shrink: 0; }
      .main { flex: 1; display: flex; flex-direction: column; padding: 20px; position: relative; }
      
      .box { background: #252525; padding: 15px; border-radius: 8px; border: 1px solid var(--border); margin-bottom: 20px; }
      .label { font-size: 12px; color: #888; margin-bottom: 8px; display: block; font-weight: 600; }
      .code-block { font-family: monospace; font-size: 12px; color: var(--primary); word-break: break-all; background: #111; padding: 10px; border-radius: 4px; cursor: pointer; }
      
      input, select, textarea { width: 100%; background: #333; border: 1px solid #444; color: #fff; padding: 10px; border-radius: 4px; margin-bottom: 15px; box-sizing: border-box; }
      button { width: 100%; padding: 12px; background: var(--primary); border: none; border-radius: 4px; font-weight: bold; cursor: pointer; color: #000; }
      button:disabled { background: #555; cursor: not-allowed; }
      
      .chat-window { flex: 1; background: #000; border: 1px solid var(--border); border-radius: 8px; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 20px; }
      .msg { max-width: 85%; padding: 15px; border-radius: 8px; line-height: 1.6; }
      .msg.user { align-self: flex-end; background: #333; color: #fff; }
      .msg.ai { align-self: flex-start; background: #1a1a1a; border: 1px solid #333; width: 100%; max-width: 100%; }
      .msg img { max-width: 200px; border-radius: 4px; display: block; margin-bottom: 10px; }

      /* 上传区域 */
      .upload-area { 
        border: 2px dashed #555; padding: 0; text-align: center; cursor: pointer; border-radius: 6px; margin-bottom: 15px; 
        height: 120px; display: flex; align-items: center; justify-content: center; position: relative; overflow: hidden;
        transition: border-color 0.2s;
      }
      .upload-area:hover { border-color: var(--primary); background-color: #2a2a2a; }
      .upload-text { font-size: 13px; color: #aaa; pointer-events: none; z-index: 2; }
      .preview-img { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; background: #000; opacity: 0.6; z-index: 1; }
      
      .log-panel { height: 150px; background: #111; border-top: 1px solid var(--border); padding: 10px; font-family: monospace; font-size: 12px; color: #888; overflow-y: auto; }
      .log-entry { margin-bottom: 4px; border-bottom: 1px solid #222; padding-bottom: 2px; }
      .log-time { color: #555; margin-right: 8px; }
    </style>
</head>
<body>
    <div class="sidebar">
        <h2 style="margin-top:0; display:flex; align-items:center; gap:10px;">
            👁️ ${CONFIG.PROJECT_NAME} 
            <span style="font-size:12px;color:#888; font-weight:normal; margin-top:4px;">v${CONFIG.PROJECT_VERSION}</span>
        </h2>
        
        <div class="box">
            <span class="label">API 密钥</span>
            <div class="code-block" onclick="copy('${apiKey}')">${apiKey}</div>
        </div>

        <div class="box">
            <span class="label">API 端点</span>
            <div class="code-block" onclick="copy('${origin}/v1/chat/completions')">${origin}/v1/chat/completions</div>
        </div>

        <div class="box">
            <span class="label">上传图片 (必需)</span>
            <input type="file" id="file-input" accept="image/*" style="display:none" onchange="handleFile()">
            <div class="upload-area" id="upload-area" onclick="document.getElementById('file-input').click()">
                <span class="upload-text" id="upload-text">点击或拖拽上传图片</span>
            </div>

            <span class="label">提示词 (可选)</span>
            <textarea id="prompt" rows="2" placeholder="例如: 详细描述这张图片..."></textarea>
            
            <button id="btn-gen" onclick="generate()">🔍 开始分析</button>
        </div>
    </div>

    <main class="main">
        <div class="chat-window" id="chat">
            <div style="color:#666; text-align:center; margin-top:100px;">
                <div style="font-size:40px; margin-bottom:20px;">🖼️</div>
                <h3>JoyCaption 视觉代理就绪</h3>
                <p>请上传图片以获取详细的 AI 描述。</p>
            </div>
        </div>
        <div class="log-panel" id="logs">
            <div class="log-entry">系统初始化完成...</div>
        </div>
    </main>

    <script>
        const API_KEY = "${apiKey}";
        const ENDPOINT = "${origin}/v1/chat/completions";
        let currentBase64 = null;

        function log(msg) {
            const div = document.createElement('div');
            div.className = 'log-entry';
            div.innerHTML = \`<span class="log-time">\${new Date().toLocaleTimeString()}</span> \${msg}\`;
            const logs = document.getElementById('logs');
            logs.appendChild(div);
            logs.scrollTop = logs.scrollHeight;
        }

        function copy(text) {
            navigator.clipboard.writeText(text);
            log("已复制到剪贴板");
        }

        function handleFile() {
            const input = document.getElementById('file-input');
            const file = input.files[0];
            if (!file) return;

            // 在浏览器端使用 FileReader 是完全合法的
            const reader = new FileReader();
            reader.onload = (e) => {
                currentBase64 = e.target.result;
                const area = document.getElementById('upload-area');
                const text = document.getElementById('upload-text');
                
                // 清除旧预览
                const oldImg = area.querySelector('.preview-img');
                if(oldImg) oldImg.remove();
                
                const img = document.createElement('img');
                img.src = currentBase64;
                img.className = 'preview-img';
                area.appendChild(img);
                text.style.display = 'none';
                log("图片已加载: " + file.name);
            };
            reader.readAsDataURL(file);
        }

        function appendMsg(role, content, imgData = null) {
            const div = document.createElement('div');
            div.className = \`msg \${role}\`;
            let html = "";
            if (imgData) html += \`<img src="\${imgData}">\`;
            html += \`<div>\${content}</div>\`;
            div.innerHTML = html;
            document.getElementById('chat').appendChild(div);
            div.scrollIntoView({ behavior: "smooth" });
            return div.querySelector('div'); // 返回文本容器
        }

        async function generate() {
            if (!currentBase64) return alert('请先上传图片');
            const prompt = document.getElementById('prompt').value.trim();

            const btn = document.getElementById('btn-gen');
            btn.disabled = true;
            btn.innerText = '⏳ 分析中...';

            // 清空欢迎页
            if(document.querySelector('.chat-window').innerText.includes('视觉代理就绪')) {
                document.getElementById('chat').innerHTML = '';
            }

            appendMsg('user', prompt || "详细描述这张图片", currentBase64);
            const aiTextEl = appendMsg('ai', 'Thinking...');
            let fullText = "";

            try {
                log("发送请求到 Worker...");
                const res = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: { 
                        'Authorization': 'Bearer ' + API_KEY, 
                        'Content-Type': 'application/json' 
                    },
                    body: JSON.stringify({
                        model: "joy-caption-beta",
                        messages: [
                            {
                                role: "user",
                                content: [
                                    { type: "text", text: prompt },
                                    { type: "image_url", image_url: { url: currentBase64 } }
                                ]
                            }
                        ],
                        stream: true
                    })
                });

                if (!res.ok) throw new Error(await res.text());

                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                aiTextEl.innerText = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    const chunk = decoder.decode(value);
                    const lines = chunk.split('\\n');
                    
                    for (const line of lines) {
                        if (line.startsWith('data: ')) {
                            const jsonStr = line.slice(6);
                            if (jsonStr === '[DONE]') break;
                            try {
                                const json = JSON.parse(jsonStr);
                                const content = json.choices[0].delta.content;
                                if (content) {
                                    fullText += content;
                                    aiTextEl.innerText = fullText;
                                }
                            } catch (e) {}
                        }
                    }
                }
                log("生成完成");

            } catch (e) {
                aiTextEl.innerText = "❌ 错误: " + e.message;
                log("Error: " + e.message);
            } finally {
                btn.disabled = false;
                btn.innerText = '🔍 开始分析';
            }
        }
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8'
    },
  });
}
