/**
 * NapCat Plugin: OpenClaw AI Channel
 *
 * 通过 OpenClaw Gateway 的 WebSocket RPC 协议（chat.send）将 QQ 变为 AI 助手通道。
 * 所有斜杠命令由 Gateway 统一处理，与 TUI/Telegram 体验一致。
 *
 * @author CharTyr
 * @license MIT
 */

import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { GatewayClient } from './gateway-client';
import { DEFAULT_CONFIG, buildConfigSchema } from './config';
import type { PluginConfig, ExtractedMedia, ChatEventPayload, ContentBlock } from './types';

const execAsync = promisify(exec);

// ========== State ==========
let logger: any = null;
let configPath: string | null = null;
let botUserId: string | number | null = null;
let gatewayClient: GatewayClient | null = null;
let currentConfig: PluginConfig = { ...DEFAULT_CONFIG };
let cacheCleanupTimer: ReturnType<typeof setInterval> | null = null;

// ========== Media Cache ==========

function getCachePath(): string {
  return currentConfig.media.cachePath;
}

function ensureCacheDir(): void {
  const dir = getCachePath();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getCacheDirSize(): number {
  const dir = getCachePath();
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const f of fs.readdirSync(dir)) {
    try { total += fs.statSync(path.join(dir, f)).size; } catch { /* skip */ }
  }
  return total;
}

function evictOldestFiles(needBytes: number): void {
  const dir = getCachePath();
  if (!fs.existsSync(dir)) return;
  const maxBytes = currentConfig.media.cacheMaxSizeMB * 1024 * 1024;
  let currentSize = getCacheDirSize();
  if (currentSize + needBytes <= maxBytes) return;

  const files = fs.readdirSync(dir)
    .map((f) => { try { const s = fs.statSync(path.join(dir, f)); return { name: f, mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; } })
    .filter(Boolean) as { name: string; mtimeMs: number; size: number }[];
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);

  for (const f of files) {
    if (currentSize + needBytes <= maxBytes) break;
    try { fs.unlinkSync(path.join(dir, f.name)); currentSize -= f.size; } catch { /* skip */ }
  }
}

function cleanExpiredCache(): void {
  const dir = getCachePath();
  if (!fs.existsSync(dir)) return;
  const ttlMs = currentConfig.media.cacheTTLMinutes * 60 * 1000;
  const now = Date.now();
  for (const f of fs.readdirSync(dir)) {
    try {
      const fp = path.join(dir, f);
      if (now - fs.statSync(fp).mtimeMs > ttlMs) fs.unlinkSync(fp);
    } catch { /* skip */ }
  }
}

function startCacheCleanup(): void {
  stopCacheCleanup();
  if (!currentConfig.media.cacheEnabled) return;
  const intervalMs = currentConfig.media.cacheTTLMinutes * 60 * 1000;
  cacheCleanupTimer = setInterval(() => cleanExpiredCache(), intervalMs);
}

function stopCacheCleanup(): void {
  if (cacheCleanupTimer) { clearInterval(cacheCleanupTimer); cacheCleanupTimer = null; }
}

async function downloadMedia(url: string, ext: string): Promise<string | null> {
  try {
    ensureCacheDir();
    const filename = `${randomUUID()}${ext}`;
    const filepath = path.join(getCachePath(), filename);

    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());

    evictOldestFiles(buf.length);
    fs.writeFileSync(filepath, buf);
    return filepath;
  } catch (e: any) {
    logger?.warn(`[OpenClaw] 媒体下载失败: ${e.message}`);
    return null;
  }
}

// ========== Local Commands ==========

function cmdHelp(): string {
  return [
    'ℹ️ Help',
    '',
    'Session',
    '  /new  |  /clear  |  /stop',
    '',
    'Options',
    '  /think <level>  |  /model <id>  |  /verbose on|off',
    '',
    'Status',
    '  /status  |  /whoami  |  /context',
    '',
    '所有 OpenClaw 命令均可直接使用',
    '更多: /commands',
  ].join('\n');
}

function cmdWhoami(
  sessionBase: string,
  userId: number | string,
  nickname: string,
  messageType: string,
  groupId?: number | string
): string {
  const epoch = sessionEpochs.get(sessionBase) || 0;
  const sessionKey = epoch > 0 ? `${sessionBase}-${epoch}` : sessionBase;
  return [
    `👤 ${nickname}`,
    `QQ: ${userId}`,
    `类型: ${messageType === 'private' ? '私聊' : `群聊 (${groupId})`}`,
    `Session: ${sessionKey}`,
  ].join('\n');
}

const LOCAL_COMMANDS: Record<string, (...args: any[]) => string> = {
  '/help': cmdHelp,
  '/whoami': cmdWhoami,
};

// ========== Session Management ==========
const sessionEpochs = new Map<string, number>();

function getSessionBase(messageType: string, userId: number | string, groupId?: number | string): string {
  if (messageType === 'private') return `qq-${userId}`;
  if (currentConfig.behavior.groupSessionMode === 'shared') return `qq-g${groupId}`;
  return `qq-g${groupId}-${userId}`;
}

function getSessionKey(sessionBase: string): string {
  const epoch = sessionEpochs.get(sessionBase) || 0;
  return epoch > 0 ? `${sessionBase}-${epoch}` : sessionBase;
}

// ========== Gateway ==========

async function getGateway(): Promise<GatewayClient> {
  if (!gatewayClient) {
    gatewayClient = new GatewayClient(
      currentConfig.openclaw.gatewayUrl,
      currentConfig.openclaw.token,
      logger
    );
  }
  if (!gatewayClient.connected) {
    await gatewayClient.connect();
  }
  return gatewayClient;
}

// ========== Message Extraction ==========

function extractMessage(segments: any[]): { extractedText: string; extractedMedia: ExtractedMedia[]; replyMessageId: string | null } {
  const textParts: string[] = [];
  const media: ExtractedMedia[] = [];
  let replyMessageId: string | null = null;

  for (const seg of segments) {
    switch (seg.type) {
      case 'text': {
        const t = seg.data?.text?.trim();
        if (t) textParts.push(t);
        break;
      }
      case 'image':
        if (seg.data?.url) media.push({ type: 'image', url: seg.data.url });
        break;
      case 'at':
        if (String(seg.data?.qq) !== String(botUserId)) {
          textParts.push(`@${seg.data?.name || seg.data?.qq}`);
        }
        break;
      case 'file':
        if (seg.data?.url) media.push({ type: 'file', url: seg.data.url, name: seg.data?.name });
        break;
      case 'record':
        if (seg.data?.url) media.push({ type: 'voice', url: seg.data.url });
        break;
      case 'video':
        if (seg.data?.url) media.push({ type: 'video', url: seg.data.url });
        break;
      case 'reply':
        if (seg.data?.id) replyMessageId = String(seg.data.id);
        break;
      case 'face':
        textParts.push(`[表情:${seg.data?.id || '?'}]`);
        break;
      case 'mface':
        textParts.push(seg.data?.summary || '[商城表情]');
        break;
    }
  }

  return { extractedText: textParts.join(' '), extractedMedia: media, replyMessageId };
}

async function resolveReply(ctx: any, messageId: string): Promise<string | null> {
  try {
    const result = await ctx.actions.call(
      'get_msg',
      { message_id: messageId },
      ctx.adapterName,
      ctx.pluginManager?.config
    );
    const msg = result?.data || result;
    if (!msg) return null;

    const senderName = msg.sender?.nickname || msg.sender?.user_id || '未知';
    const senderQQ = msg.sender?.user_id || '';

    const textParts: string[] = [];
    const mediaItems: ExtractedMedia[] = [];

    // Try segments array first
    const segments = Array.isArray(msg.message) ? msg.message : [];
    if (segments.length > 0) {
      for (const seg of segments) {
        switch (seg.type) {
          case 'text': {
            const t = seg.data?.text?.trim();
            if (t) textParts.push(t);
            break;
          }
          case 'image':
            if (seg.data?.url) mediaItems.push({ type: 'image', url: seg.data.url });
            break;
          case 'file':
            if (seg.data?.url) mediaItems.push({ type: 'file', url: seg.data.url, name: seg.data?.name });
            break;
          case 'record':
            if (seg.data?.url) mediaItems.push({ type: 'voice', url: seg.data.url });
            break;
          case 'video':
            if (seg.data?.url) mediaItems.push({ type: 'video', url: seg.data.url });
            break;
          case 'at':
            textParts.push(`@${seg.data?.name || seg.data?.qq}`);
            break;
          case 'face':
            textParts.push(`[表情:${seg.data?.id || '?'}]`);
            break;
          case 'mface':
            textParts.push(seg.data?.summary || '[商城表情]');
            break;
        }
      }
    } else if (msg.raw_message && typeof msg.raw_message === 'string') {
      // Parse CQ codes from raw_message
      const raw = msg.raw_message;
      let lastIdx = 0;
      const cqRegex = /\[CQ:(\w+)((?:,[^,\]]+)*)\]/g;
      let match;
      while ((match = cqRegex.exec(raw)) !== null) {
        const before = raw.slice(lastIdx, match.index).trim();
        if (before) textParts.push(before);
        lastIdx = match.index + match[0].length;

        const cqType = match[1];
        const paramsStr = match[2];
        const params: Record<string, string> = {};
        if (paramsStr) {
          for (const p of paramsStr.slice(1).split(',')) {
            const eq = p.indexOf('=');
            if (eq > 0) params[p.slice(0, eq)] = p.slice(eq + 1);
          }
        }
        if (cqType === 'image' && params.url) mediaItems.push({ type: 'image', url: params.url });
        else if (cqType === 'file' && params.url) mediaItems.push({ type: 'file', url: params.url, name: params.file });
        else if (cqType === 'record' && params.url) mediaItems.push({ type: 'voice', url: params.url });
        else if (cqType === 'video' && params.url) mediaItems.push({ type: 'video', url: params.url });
        else if (cqType === 'at') textParts.push(`@${params.name || params.qq || ''}`);
      }
      const tail = raw.slice(lastIdx).trim();
      if (tail) textParts.push(tail);
    }

    // Build media lines (with cache support)
    const mediaParts: string[] = [];
    for (const m of mediaItems) {
      if (currentConfig.media.cacheEnabled && m.url) {
        const extMap: Record<string, string> = { image: '.jpg', file: '', voice: '.amr', video: '.mp4' };
        const ext = m.name ? path.extname(m.name) : (extMap[m.type] || '');
        const localPath = await downloadMedia(m.url, ext);
        if (localPath) {
          mediaParts.push(`[${m.type}: file://${localPath}${m.name ? ` (${m.name})` : ''}]`);
          continue;
        }
      }
      mediaParts.push(`[${m.type}: ${m.url}${m.name ? ` (${m.name})` : ''}]`);
    }

    const body = textParts.join(' ');
    const mediaStr = mediaParts.length > 0 ? '\n' + mediaParts.join('\n') : '';
    const content = body + mediaStr;
    if (!content.trim()) return null;

    return `[引用 ${senderName}(${senderQQ}) 的消息]\n${content}\n[/引用]`;
  } catch (e: any) {
    logger?.warn(`[OpenClaw] 解析引用消息失败: ${e.message}`);
    return null;
  }
}

// ========== Text Extraction from Chat Event ==========

function extractTextFromPayload(message: any): string {
  if (typeof message === 'string') return message;
  if (!message) return '';

  const content = message.content;
  if (!content) return message.text ?? '';

  const blocks: any[] = Array.isArray(content) ? content : [content];
  let text = '';
  for (const b of blocks) {
    if (typeof b === 'string') text += b;
    else if (b?.text) text += b.text;
  }
  return text;
}

function extractContentText(message: any): string {
  return extractTextFromPayload(message);
}

// ========== Typing Status ==========

async function setTypingStatus(ctx: any, userId: number | string, typing: boolean): Promise<void> {
  try {
    await ctx.actions.call(
      'set_input_status',
      { user_id: String(userId), event_type: typing ? 1 : 0 },
      ctx.adapterName,
      ctx.pluginManager?.config
    );
  } catch (e: any) {
    logger?.warn(`[OpenClaw] 设置输入状态失败: ${e.message}`);
  }
}

// ========== Message Sending ==========

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendReply(ctx: any, messageType: string, groupId: any, userId: any, text: string, opts?: { eventMessageId?: string | number }): Promise<void> {
  const action = messageType === 'group' ? 'send_group_msg' : 'send_private_msg';
  const idKey = messageType === 'group' ? 'group_id' : 'user_id';
  const idVal = String(messageType === 'group' ? groupId : userId);

  // Build prefix segments for group replies (at + quote)
  const prefixSegs: any[] = [];
  if (messageType === 'group') {
    if (currentConfig.behavior.replyQuoteMessage && opts?.eventMessageId) {
      prefixSegs.push({ type: 'reply', data: { id: String(opts.eventMessageId) } });
    }
    if (currentConfig.behavior.replyAtSender) {
      prefixSegs.push({ type: 'at', data: { qq: String(userId) } });
    }
  }

  // Extract MEDIA: lines from reply
  const mediaRegex = /^MEDIA:\s*(.+)$/gm;
  const mediaFiles: string[] = [];
  let match;
  while ((match = mediaRegex.exec(text)) !== null) {
    const filePath = match[1].trim();
    if (filePath) mediaFiles.push(filePath);
  }
  let cleanText = text.replace(/^MEDIA:\s*.+$/gm, '').trim();

  // Dedup: if text starts with @userId or [CQ:reply,...] that we're already adding as segments
  if (messageType === 'group' && prefixSegs.length > 0) {
    let deduped = false;
    // Remove leading @mention matching the sender
    const atPattern = new RegExp(`^@\\S+\\s*\\(${userId}\\)\\s*`);
    if (currentConfig.behavior.replyAtSender && atPattern.test(cleanText)) {
      cleanText = cleanText.replace(atPattern, '').trim();
      deduped = true;
    }
    // Remove leading CQ:reply or [引用...] patterns
    if (currentConfig.behavior.replyQuoteMessage) {
      const cqReply = /^\[CQ:reply[^\]]*\]\s*/;
      if (cqReply.test(cleanText)) {
        cleanText = cleanText.replace(cqReply, '').trim();
        deduped = true;
      }
    }
    if (deduped) logger?.warn('[OpenClaw] 在消息开头发现重复的 @/引用，已去重');
  }

  // Send text part
  if (cleanText) {
    const maxLen = 3000;
    if (cleanText.length <= maxLen) {
      const message = [...prefixSegs, { type: 'text', data: { text: cleanText } }];
      await ctx.actions.call(action, { [idKey]: idVal, message }, ctx.adapterName, ctx.pluginManager?.config);
    } else {
      const total = Math.ceil(cleanText.length / maxLen);
      for (let i = 0; i < cleanText.length; i += maxLen) {
        const idx = Math.floor(i / maxLen) + 1;
        const prefix = total > 1 ? `[${idx}/${total}]\n` : '';
        const segs = i === 0 ? [...prefixSegs] : [];
        segs.push({ type: 'text', data: { text: prefix + cleanText.slice(i, i + maxLen) } });
        await ctx.actions.call(
          action,
          { [idKey]: idVal, message: segs },
          ctx.adapterName,
          ctx.pluginManager?.config
        );
        if (i + maxLen < cleanText.length) await sleep(1000);
      }
    }
  }

  // Send media files
  for (const filePath of mediaFiles) {
    try {
      const fileName = path.basename(filePath);
      const ext = path.extname(fileName).toLowerCase();
      const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'];

      if (imageExts.includes(ext)) {
        // Send as inline image message
        const message = [{ type: 'image', data: { file: `file://${filePath}` } }];
        await ctx.actions.call(action, { [idKey]: idVal, message }, ctx.adapterName, ctx.pluginManager?.config);
      } else {
        // Send as file upload
        if (messageType === 'group') {
          await ctx.actions.call('upload_group_file', {
            group_id: idVal, file: filePath, name: fileName, upload_file: true,
          }, ctx.adapterName, ctx.pluginManager?.config);
        } else {
          await ctx.actions.call('upload_private_file', {
            user_id: idVal, file: filePath, name: fileName, upload_file: true,
          }, ctx.adapterName, ctx.pluginManager?.config);
        }
      }
    } catch (e: any) {
      logger?.warn(`[OpenClaw] 发送文件失败 ${filePath}: ${e.message}`);
    }
  }
}

// ========== Lifecycle ==========

export const plugin_config_ui = buildConfigSchema();

export const plugin_init = async (ctx: any): Promise<void> => {
  logger = ctx.logger;
  configPath = ctx.configPath;
  logger.info('[OpenClaw] QQ Channel 插件初始化中...');

  // Load saved config
  try {
    if (configPath && fs.existsSync(configPath)) {
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      currentConfig = deepMerge(currentConfig, saved);
      logger.info('[OpenClaw] 已加载保存的配置');
    }
  } catch (e: any) {
    logger.warn('[OpenClaw] 加载配置失败: ' + e.message);
  }

  // Pre-connect gateway
  try {
    await getGateway();
    logger.info('[OpenClaw] Gateway 连接就绪');
  } catch (e: any) {
    logger.error(`[OpenClaw] Gateway 预连接失败: ${e.message}（将在首次消息时重试）`);
  }

  logger.info(`[OpenClaw] 网关: ${currentConfig.openclaw.gatewayUrl}`);
  logger.info('[OpenClaw] 模式: 私聊全透传 + 群聊@触发 + 命令透传');
  logger.info('[OpenClaw] QQ Channel 插件初始化完成');
  startCacheCleanup();
};

export const plugin_onmessage = async (ctx: any, event: any): Promise<void> => {
  try {
    if (!logger) return;
    if (event.post_type !== 'message') return;

    const userId = event.user_id;
    const nickname = event.sender?.nickname || '未知';
    const messageType = event.message_type;
    const groupId = event.group_id;
    const eventMessageId = event.message_id;

    if (!botUserId && event.self_id) {
      botUserId = event.self_id;
      logger.info(`[OpenClaw] Bot QQ: ${botUserId}`);
    }

    // User blacklist (takes priority over whitelist)
    const userBlacklist = currentConfig.behavior.userBlacklist;
    if (userBlacklist.length > 0 && userBlacklist.some((id) => Number(id) === Number(userId))) return;

    // User whitelist (bypass in whitelisted groups if configured)
    const userWhitelist = currentConfig.behavior.userWhitelist;
    if (userWhitelist.length > 0) {
      const inWhitelistedGroup = messageType === 'group' && groupId
        && currentConfig.behavior.groupBypassUserWhitelist
        && currentConfig.behavior.groupWhitelist.length > 0
        && currentConfig.behavior.groupWhitelist.some((id) => Number(id) === Number(groupId));
      if (!inWhitelistedGroup && !userWhitelist.some((id) => Number(id) === Number(userId))) return;
    }

    let shouldHandle = false;

    if (messageType === 'private') {
      if (!currentConfig.behavior.privateChat) return;
      shouldHandle = true;
    } else if (messageType === 'group') {
      if (!groupId) return;
      const gWhitelist = currentConfig.behavior.groupWhitelist;
      if (gWhitelist.length > 0 && !gWhitelist.some((id) => Number(id) === Number(groupId))) return;
      if (currentConfig.behavior.groupAtOnly) {
        const isAtBot = event.message?.some(
          (seg: any) => seg.type === 'at' && String(seg.data?.qq) === String(botUserId || event.self_id)
        );
        if (!isAtBot) return;
      }
      shouldHandle = true;
    }

    if (!shouldHandle) return;

    const { extractedText, extractedMedia, replyMessageId } = extractMessage(event.message || []);
    const text = extractedText;
    if (!text && extractedMedia.length === 0 && !replyMessageId) return;

    // Resolve quoted/replied message
    let replyContext = '';
    if (replyMessageId && currentConfig.behavior.resolveReply) {
      const resolved = await resolveReply(ctx, replyMessageId);
      if (resolved) replyContext = resolved;
    }

    const sessionBase = getSessionBase(messageType, userId, groupId);

    // Command permission check: if commandAdminOnly is on, non-admin /commands are ignored
    if (text?.startsWith('/') && currentConfig.behavior.commandAdminOnly) {
      const admins = currentConfig.behavior.adminQQ;
      if (admins.length > 0 && !admins.some((id) => Number(id) === Number(userId))) {
        logger.info(`[OpenClaw] 非管理员指令已忽略: ${nickname}(${userId})`);
        return;
      }
    }

    // Local commands
    if (text?.startsWith('/')) {
      const spaceIdx = text.indexOf(' ');
      const cmd = (spaceIdx > 0 ? text.slice(0, spaceIdx) : text).toLowerCase();
      const args = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : '';

      if (LOCAL_COMMANDS[cmd]) {
        logger.info(`[OpenClaw] 本地命令: ${cmd} from ${nickname}(${userId})`);
        const result = LOCAL_COMMANDS[cmd](sessionBase, userId, nickname, messageType, groupId, args);
        if (result) {
          await sendReply(ctx, messageType, groupId, userId, result, { eventMessageId });
          return;
        }
      }
    }

    // Resolve group name for group messages
    let groupName = '';
    if (messageType === 'group' && groupId) {
      try {
        const info = await ctx.actions.call(
          'get_group_info',
          { group_id: String(groupId) },
          ctx.adapterName,
          ctx.pluginManager?.config
        );
        groupName = info?.data?.group_name || info?.group_name || '';
      } catch {
        groupName = '';
      }
    }

    // Build message with sender identity context
    const identityParts = [`[发送者: ${nickname} (QQ: ${userId})`];
    if (messageType === 'group' && groupId) identityParts.push(`群: ${groupName || groupId} (${groupId})`);
    identityParts.push(messageType === 'private' ? '私聊]' : '群聊]');
    const identityHeader = identityParts.join(' | ');

    let openclawMessage = `${identityHeader}\n`;
    if (replyContext) openclawMessage += replyContext + '\n';
    openclawMessage += text || '';
    if (extractedMedia.length > 0) {
      const mediaLines: string[] = [];
      for (const m of extractedMedia) {
        if (currentConfig.media.cacheEnabled && m.url) {
          const extMap: Record<string, string> = { image: '.jpg', file: '', voice: '.amr', video: '.mp4' };
          const ext = m.name ? path.extname(m.name) : (extMap[m.type] || '');
          const localPath = await downloadMedia(m.url, ext);
          if (localPath) {
            mediaLines.push(`[${m.type}: file://${localPath}${m.name ? ` (${m.name})` : ''}]`);
            continue;
          }
        }
        mediaLines.push(`[${m.type}: ${m.url}${m.name ? ` (${m.name})` : ''}]`);
      }
      openclawMessage += '\n\n' + mediaLines.join('\n');
    }

    logger.info(
      `[OpenClaw] ${messageType === 'private' ? '私聊' : `群${groupId}`} ${nickname}(${userId}): ${openclawMessage.slice(0, 80)}`
    );

    if (messageType === 'private') setTypingStatus(ctx, userId, true);

    // Send via Gateway RPC + event listener (non-streaming)
    const sessionKey = getSessionKey(sessionBase);
    const runId = randomUUID();

    try {
      const gw = await getGateway();

      // Listen for chat events — only use final (contains full text)
      const replyPromise = new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => {
          cleanup();
          resolve(null);
        }, 180000);

        const cleanup = () => {
          clearTimeout(timeout);
          gw.eventHandlers.delete('chat');
        };

        gw.eventHandlers.set('chat', (payload: any) => {
          if (!payload) return;
          logger.info(`[OpenClaw] chat event: state=${payload.state} session=${payload.sessionKey} run=${payload.runId?.slice(0, 8)}`);
          if (payload.sessionKey !== sessionKey && !payload.sessionKey?.endsWith(':' + sessionKey)) return;

          if (payload.state === 'final') {
            const text = extractContentText(payload.message);
            cleanup();
            resolve(text?.trim() || null);
          }

          if (payload.state === 'aborted') {
            cleanup();
            resolve('⏹ 已中止');
          }

          if (payload.state === 'error') {
            cleanup();
            resolve(`❌ ${payload.errorMessage || '处理出错'}`);
          }
        });
      });

      // Send message
      const sendResult = await gw.request('chat.send', {
        sessionKey,
        message: openclawMessage,
        idempotencyKey: runId,
      });

      logger.info(`[OpenClaw] chat.send 已接受: runId=${sendResult?.runId}`);

      // Wait for final event
      const reply = await replyPromise;

      if (reply) {
        await sendReply(ctx, messageType, groupId, userId, reply, { eventMessageId });
      } else {
        logger.info('[OpenClaw] 无回复内容');
      }
    } catch (e: any) {
      logger.error(`[OpenClaw] 发送失败: ${e.message}`);
      if (gatewayClient) {
        gatewayClient.disconnect();
        gatewayClient = null;
      }
      try {
        const escapedMessage = openclawMessage.replace(/'/g, "'\\''");
        const cliPath = currentConfig.openclaw.cliPath;
        const { stdout } = await execAsync(
          `OPENCLAW_TOKEN='${currentConfig.openclaw.token}' ${cliPath} agent --session-id '${sessionKey}' --message '${escapedMessage}' 2>&1`,
          { timeout: 180000, maxBuffer: 1024 * 1024 }
        );
        if (stdout.trim()) {
          await sendReply(ctx, messageType, groupId, userId, stdout.trim(), { eventMessageId });
        }
      } catch (e2: any) {
        await sendReply(ctx, messageType, groupId, userId, `处理出错: ${(e as Error).message?.slice(0, 100)}`, { eventMessageId });
      }
    }
  } catch (outerErr: any) {
    logger?.error(`[OpenClaw] 未捕获异常: ${outerErr.message}\n${outerErr.stack}`);
  }
};

export const plugin_cleanup = async (): Promise<void> => {
  stopCacheCleanup();
  if (gatewayClient) {
    gatewayClient.disconnect();
    gatewayClient = null;
  }
  logger?.info('[OpenClaw] QQ Channel 插件清理完成');
};

// ========== Config Hooks ==========

export const plugin_get_config = async () => {
  return {
    'openclaw.token': currentConfig.openclaw.token,
    'openclaw.gatewayUrl': currentConfig.openclaw.gatewayUrl,
    'openclaw.cliPath': currentConfig.openclaw.cliPath,
    'behavior.privateChat': currentConfig.behavior.privateChat,
    'behavior.groupAtOnly': currentConfig.behavior.groupAtOnly,
    'behavior.adminQQ': currentConfig.behavior.adminQQ.join(', '),
    'behavior.commandAdminOnly': currentConfig.behavior.commandAdminOnly,
    'behavior.userWhitelist': currentConfig.behavior.userWhitelist.join(', '),
    'behavior.groupWhitelist': currentConfig.behavior.groupWhitelist.join(', '),
    'behavior.groupBypassUserWhitelist': currentConfig.behavior.groupBypassUserWhitelist,
    'behavior.userBlacklist': currentConfig.behavior.userBlacklist.join(', '),
    'behavior.debounceMs': currentConfig.behavior.debounceMs,
    'behavior.resolveReply': currentConfig.behavior.resolveReply,
    'behavior.replyMaxDepth': currentConfig.behavior.replyMaxDepth,
    'behavior.groupSessionMode': currentConfig.behavior.groupSessionMode,
    'behavior.replyAtSender': currentConfig.behavior.replyAtSender,
    'behavior.replyQuoteMessage': currentConfig.behavior.replyQuoteMessage,
    'media.cacheEnabled': currentConfig.media.cacheEnabled,
    'media.cachePath': currentConfig.media.cachePath,
    'media.cacheMaxSizeMB': currentConfig.media.cacheMaxSizeMB,
    'media.cacheTTLMinutes': currentConfig.media.cacheTTLMinutes,
  };
};

export const plugin_set_config = async (ctx: any, config: any): Promise<void> => {
  const unflattened = unflattenConfig(config);
  // Convert comma-separated whitelist strings back to number[]
  if (unflattened.behavior) {
    if (typeof unflattened.behavior.adminQQ === 'string') {
      unflattened.behavior.adminQQ = unflattened.behavior.adminQQ
        .split(',').map((s: string) => s.trim()).filter(Boolean).map(Number);
    }
    if (typeof unflattened.behavior.userWhitelist === 'string') {
      unflattened.behavior.userWhitelist = unflattened.behavior.userWhitelist
        .split(',').map((s: string) => s.trim()).filter(Boolean).map(Number);
    }
    if (typeof unflattened.behavior.groupWhitelist === 'string') {
      unflattened.behavior.groupWhitelist = unflattened.behavior.groupWhitelist
        .split(',').map((s: string) => s.trim()).filter(Boolean).map(Number);
    }
    if (typeof unflattened.behavior.userBlacklist === 'string') {
      unflattened.behavior.userBlacklist = unflattened.behavior.userBlacklist
        .split(',').map((s: string) => s.trim()).filter(Boolean).map(Number);
    }
  }
  currentConfig = deepMerge({ ...DEFAULT_CONFIG }, unflattened);
  if (gatewayClient) {
    gatewayClient.disconnect();
    gatewayClient = null;
  }
  if (ctx?.configPath) {
    try {
      const dir = path.dirname(ctx.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ctx.configPath, JSON.stringify(currentConfig, null, 2), 'utf-8');
    } catch (e: any) {
      logger?.error('[OpenClaw] 保存配置失败: ' + e.message);
    }
  }
  startCacheCleanup();
};

// ========== Utils ==========

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function unflattenConfig(config: any): any {
  if (!config || typeof config !== 'object') return config;
  const hasDotKey = Object.keys(config).some((k) => k.includes('.'));
  if (!hasDotKey) return config;
  const result: any = {};
  for (const [key, value] of Object.entries(config)) {
    const parts = key.split('.');
    let cur = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }
  return result;
}
