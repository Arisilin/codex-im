const { filterThreadsByWorkspaceRoot } = require("../../shared/workspace-paths");
const { extractSwitchThreadId } = require("../../shared/command-parsing");
const codexMessageUtils = require("../../infra/codex/message-utils");

const THREAD_SOURCE_KINDS = new Set([
  "app",
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
]);
const INTERRUPT_PROTECTED_ITEM_TYPES = new Set(["collabagenttoolcall"]);

async function resolveWorkspaceThreadState(runtime, {
  bindingKey,
  workspaceRoot,
  normalized,
  autoSelectThread = true,
}) {
  const threads = await refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized);
  const selectedThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  const threadId = selectedThreadId || (autoSelectThread ? (threads[0]?.id || "") : "");
  if (!selectedThreadId && threadId) {
    runtime.sessionStore.setThreadIdForWorkspace(
      bindingKey,
      workspaceRoot,
      threadId,
      codexMessageUtils.buildBindingMetadata(normalized)
    );
  }
  if (threadId) {
    runtime.setThreadBindingKey(threadId, bindingKey);
    runtime.setThreadWorkspaceRoot(threadId, workspaceRoot);
  }
  return { threads, threadId, selectedThreadId };
}

async function ensureThreadAndSendMessage(runtime, { bindingKey, workspaceRoot, normalized, threadId }) {
  const codexParams = runtime.getCodexParamsForWorkspace(bindingKey, workspaceRoot);

  if (!threadId) {
    const createdThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    console.log(`[codex-im] turn/start first message thread=${createdThreadId}`);
    await runtime.codex.sendUserMessage({
      threadId: createdThreadId,
      text: normalized.text,
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    runtime.setThreadBindingKey(createdThreadId, bindingKey);
    runtime.setThreadWorkspaceRoot(createdThreadId, workspaceRoot);
    return createdThreadId;
  }

  try {
    await ensureThreadResumed(runtime, threadId);
    await runtime.codex.sendUserMessage({
      threadId,
      text: normalized.text,
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    console.log(`[codex-im] turn/start ok workspace=${workspaceRoot} thread=${threadId}`);
    runtime.setThreadBindingKey(threadId, bindingKey);
    runtime.setThreadWorkspaceRoot(threadId, workspaceRoot);
    return threadId;
  } catch (error) {
    if (!shouldRecreateThread(error)) {
      throw error;
    }

    console.warn(`[codex-im] stale thread detected, recreating workspace thread: ${threadId}`);
    runtime.resumedThreadIds.delete(threadId);
    runtime.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    const recreatedThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    console.log(`[codex-im] turn/start retry thread=${recreatedThreadId}`);
    await runtime.codex.sendUserMessage({
      threadId: recreatedThreadId,
      text: normalized.text,
      model: codexParams.model || null,
      effort: codexParams.effort || null,
      accessMode: runtime.config.defaultCodexAccessMode,
      workspaceRoot,
    });
    runtime.setThreadBindingKey(recreatedThreadId, bindingKey);
    runtime.setThreadWorkspaceRoot(recreatedThreadId, workspaceRoot);
    return recreatedThreadId;
  }
}

async function createWorkspaceThread(runtime, { bindingKey, workspaceRoot, normalized }) {
  const response = await runtime.codex.startThread({
    cwd: workspaceRoot,
  });
  console.log(`[codex-im] thread/start ok workspace=${workspaceRoot}`);

  const resolvedThreadId = codexMessageUtils.extractThreadId(response);
  if (!resolvedThreadId) {
    throw new Error("thread/start did not return a thread id");
  }

  runtime.sessionStore.setThreadIdForWorkspace(
    bindingKey,
    workspaceRoot,
    resolvedThreadId,
    codexMessageUtils.buildBindingMetadata(normalized)
  );
  runtime.resumedThreadIds.add(resolvedThreadId);
  runtime.setPendingThreadContext(resolvedThreadId, normalized);
  runtime.setThreadBindingKey(resolvedThreadId, bindingKey);
  runtime.setThreadWorkspaceRoot(resolvedThreadId, workspaceRoot);
  return resolvedThreadId;
}

async function ensureThreadResumed(runtime, threadId) {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (!normalizedThreadId || runtime.resumedThreadIds.has(normalizedThreadId)) {
    return null;
  }

  const response = await runtime.codex.resumeThread({ threadId: normalizedThreadId });
  runtime.resumedThreadIds.add(normalizedThreadId);
  console.log(`[codex-im] thread/resume ok thread=${normalizedThreadId}`);
  return response;
}

async function handleNewCommand(runtime, normalized) {
  const bindingKey = runtime.sessionStore.buildBindingKey(normalized);
  const workspaceRoot = runtime.resolveWorkspaceRootForBinding(bindingKey);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  try {
    const createdThreadId = await createWorkspaceThread(runtime, {
      bindingKey,
      workspaceRoot,
      normalized,
    });
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `已创建新线程并切换到它:\n${workspaceRoot}\n\nthread: ${createdThreadId}`,
    });
    await runtime.showStatusPanel(normalized, { replyToMessageId: normalized.messageId });
  } catch (error) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `创建新线程失败: ${error.message}`,
    });
  }
}

async function handleSwitchCommand(runtime, normalized) {
  const threadId = extractSwitchThreadId(normalized.text);
  if (!threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: "用法: `/codex switch <threadId>`",
    });
    return;
  }

  await switchThreadById(runtime, normalized, threadId, { replyToMessageId: normalized.messageId });
}

async function refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized) {
  try {
    const threads = await listCodexThreadsForWorkspace(runtime, workspaceRoot);
    const currentThreadId = runtime.sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
    const shouldKeepCurrentThread = currentThreadId && runtime.resumedThreadIds.has(currentThreadId);
    if (currentThreadId && !shouldKeepCurrentThread && !threads.some((thread) => thread.id === currentThreadId)) {
      runtime.sessionStore.clearThreadIdForWorkspace(bindingKey, workspaceRoot);
    }
    return threads;
  } catch (error) {
    console.warn(`[codex-im] thread/list failed for workspace=${workspaceRoot}: ${error.message}`);
    return [];
  }
}

async function listCodexThreadsForWorkspace(runtime, workspaceRoot) {
  const allThreads = await listCodexThreadsPaginated(runtime);
  const sourceFiltered = allThreads.filter((thread) => isSupportedThreadSourceKind(thread?.sourceKind));
  return filterThreadsByWorkspaceRoot(sourceFiltered, workspaceRoot);
}

async function listCodexThreadsPaginated(runtime) {
  const allThreads = [];
  const seenThreadIds = new Set();
  let cursor = null;

  for (let page = 0; page < 10; page += 1) {
    const response = await runtime.codex.listThreads({
      cursor,
      limit: 200,
      sortKey: "updated_at",
    });
    const pageThreads = codexMessageUtils.extractThreadsFromListResponse(response);
    for (const thread of pageThreads) {
      if (seenThreadIds.has(thread.id)) {
        continue;
      }
      seenThreadIds.add(thread.id);
      allThreads.push(thread);
    }

    const nextCursor = codexMessageUtils.extractThreadListCursor(response);
    if (!nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
    if (pageThreads.length === 0) {
      break;
    }
  }

  return allThreads;
}

function describeWorkspaceStatus(runtime, threadId) {
  if (!threadId) {
    return { code: "idle", label: "空闲" };
  }
  if (runtime.pendingApprovalByThreadId.has(threadId)) {
    return { code: "approval", label: "等待授权" };
  }
  if (runtime.activeTurnIdByThreadId.has(threadId)) {
    return { code: "running", label: "运行中" };
  }
  return { code: "idle", label: "空闲" };
}

async function switchThreadById(runtime, normalized, threadId, { replyToMessageId } = {}) {
  const replyTarget = runtime.resolveReplyToMessageId(normalized, replyToMessageId);
  const { bindingKey, workspaceRoot } = runtime.getBindingContext(normalized);
  if (!workspaceRoot) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "当前会话还未绑定项目。先发送 `/codex bind /绝对路径`。",
    });
    return;
  }

  const currentThreadId = runtime.resolveThreadIdForBinding(bindingKey, workspaceRoot);
  if (currentThreadId && currentThreadId === threadId) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "已经是当前线程，无需切换。",
    });
    return;
  }

  const availableThreads = await refreshWorkspaceThreads(runtime, bindingKey, workspaceRoot, normalized);
  const selectedThread = availableThreads.find((thread) => thread.id === threadId) || null;
  if (!selectedThread) {
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: replyTarget,
      text: "指定线程当前不可用，请刷新后重试。",
    });
    return;
  }

  const resolvedWorkspaceRoot = selectedThread.cwd || workspaceRoot;
  runtime.sessionStore.setActiveWorkspaceRoot(bindingKey, resolvedWorkspaceRoot);
  runtime.sessionStore.setThreadIdForWorkspace(
    bindingKey,
    resolvedWorkspaceRoot,
    threadId,
    codexMessageUtils.buildBindingMetadata(normalized)
  );
  runtime.setThreadBindingKey(threadId, bindingKey);
  runtime.setThreadWorkspaceRoot(threadId, resolvedWorkspaceRoot);
  runtime.resumedThreadIds.delete(threadId);
  await ensureThreadResumed(runtime, threadId);
  await runtime.showStatusPanel(normalized, { replyToMessageId: replyTarget });
}

function isSupportedThreadSourceKind(sourceKind) {
  const normalized = typeof sourceKind === "string" && sourceKind.trim() ? sourceKind.trim() : "unknown";
  return THREAD_SOURCE_KINDS.has(normalized);
}

function shouldRecreateThread(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("thread not found") || message.includes("unknown thread");
}

function isThreadBusy(runtime, threadId) {
  if (!threadId) {
    return false;
  }
  return runtime.pendingApprovalByThreadId.has(threadId) || runtime.activeTurnIdByThreadId.has(threadId);
}

function hasQueuedThreadMessages(runtime, threadId) {
  const queue = runtime.queuedMessagesByThreadId.get(threadId);
  return Array.isArray(queue) && queue.length > 0;
}

function enqueueThreadMessage(runtime, { threadId, bindingKey, workspaceRoot, normalized }) {
  if (!threadId || !bindingKey || !workspaceRoot || !normalized?.messageId) {
    return;
  }

  const queue = runtime.queuedMessagesByThreadId.get(threadId) || [];
  queue.push({
    threadId,
    bindingKey,
    workspaceRoot,
    normalized,
  });
  runtime.queuedMessagesByThreadId.set(threadId, queue);
}

async function requestQueuedTurnInterrupt(runtime, threadId) {
  if (!threadId || !hasQueuedThreadMessages(runtime, threadId) || runtime.interruptRequestedByThreadId.has(threadId)) {
    return false;
  }

  const activeItem = runtime.activeItemByThreadId?.get(threadId) || null;
  if (INTERRUPT_PROTECTED_ITEM_TYPES.has(String(activeItem?.itemType || "").toLowerCase())) {
    return false;
  }

  const turnId = runtime.activeTurnIdByThreadId.get(threadId) || "";
  if (!turnId) {
    return false;
  }

  runtime.interruptRequestedByThreadId.add(threadId);
  try {
    await runtime.codex.sendRequest("turn/interrupt", {
      threadId,
      turnId,
    });
    return true;
  } catch (error) {
    runtime.interruptRequestedByThreadId.delete(threadId);
    console.error(`[codex-im] queued interrupt failed thread=${threadId}: ${error.message}`);
    return false;
  }
}

async function dispatchQueuedThreadMessage(runtime, threadId) {
  if (!threadId || runtime.queuedDispatchInFlightByThreadId.has(threadId)) {
    return false;
  }

  const queue = runtime.queuedMessagesByThreadId.get(threadId);
  if (!Array.isArray(queue) || queue.length === 0) {
    runtime.interruptRequestedByThreadId.delete(threadId);
    return false;
  }

  const queued = queue.shift();
  if (queue.length) {
    runtime.queuedMessagesByThreadId.set(threadId, queue);
  } else {
    runtime.queuedMessagesByThreadId.delete(threadId);
  }

  runtime.interruptRequestedByThreadId.delete(threadId);
  runtime.queuedDispatchInFlightByThreadId.add(threadId);

  const { bindingKey, workspaceRoot, normalized } = queued;
  runtime.sealCurrentReplyCard(threadId);
  runtime.setPendingBindingContext(bindingKey, normalized);
  runtime.setPendingThreadContext(threadId, normalized);

  try {
    await runtime.addPendingReaction(bindingKey, normalized.messageId);
    const resolvedThreadId = await runtime.ensureThreadAndSendMessage({
      bindingKey,
      workspaceRoot,
      normalized,
      threadId,
    });
    runtime.movePendingReactionToThread(bindingKey, resolvedThreadId);

    if (resolvedThreadId !== threadId && runtime.queuedMessagesByThreadId.has(threadId)) {
      runtime.queuedMessagesByThreadId.set(
        resolvedThreadId,
        runtime.queuedMessagesByThreadId.get(threadId) || []
      );
      runtime.queuedMessagesByThreadId.delete(threadId);
    }
    return true;
  } catch (error) {
    await runtime.clearPendingReactionForBinding(bindingKey);
    await runtime.sendInfoCardMessage({
      chatId: normalized.chatId,
      replyToMessageId: normalized.messageId,
      text: `插入消息失败: ${error.message}`,
      kind: "error",
    });
    console.error(`[codex-im] dispatch queued message failed thread=${threadId}: ${error.message}`);
    return false;
  } finally {
    runtime.queuedDispatchInFlightByThreadId.delete(threadId);
  }
}

module.exports = {
  createWorkspaceThread,
  dispatchQueuedThreadMessage,
  describeWorkspaceStatus,
  enqueueThreadMessage,
  ensureThreadAndSendMessage,
  ensureThreadResumed,
  hasQueuedThreadMessages,
  handleNewCommand,
  handleSwitchCommand,
  isThreadBusy,
  requestQueuedTurnInterrupt,
  refreshWorkspaceThreads,
  resolveWorkspaceThreadState,
  switchThreadById,
};
