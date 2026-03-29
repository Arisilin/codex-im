const { formatFailureText } = require("../../shared/error-text");

const QUEUED_SEND_CLEARED_TEXT = "前序消息启动失败，队列已清空，请重试。";

async function enqueueOrDispatchThreadMessage(runtime, {
  bindingKey,
  workspaceRoot,
  normalized,
  threadId,
  reviewSendOptions = {},
  failureTextPrefix = "处理失败",
} = {}) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!shouldQueueThreadSend(runtime, { normalized, threadId: normalizedThreadId, reviewSendOptions })) {
    return runtime.ensureThreadAndSendMessage({
      bindingKey,
      workspaceRoot,
      normalized,
      threadId,
      reviewSendOptions,
    });
  }

  const item = {
    bindingKey,
    workspaceRoot,
    threadId: normalizedThreadId,
    normalized,
    reviewSendOptions,
    deliveryMode: runtime.resolveTurnDeliveryMode
      ? runtime.resolveTurnDeliveryMode(normalized)
      : (normalized?.provider === "feishu" ? "live" : "session"),
    messageId: normalizeIdentifier(normalized?.messageId),
    chatId: normalizeIdentifier(normalized?.chatId),
    threadKey: normalizeIdentifier(normalized?.threadKey),
    senderId: normalizeIdentifier(normalized?.senderId),
    enqueuedAt: new Date().toISOString(),
    failureTextPrefix,
  };

  const shouldQueue = isThreadSendBusy(runtime, normalizedThreadId);
  if (shouldQueue) {
    const queued = getQueuedSendItems(runtime, normalizedThreadId);
    queued.push(item);
    setQueuedSendItems(runtime, normalizedThreadId, queued);
  } else {
    setActiveSendState(runtime, item, "starting");
  }

  try {
    if (item.messageId) {
      await runtime.addPendingReactionForMessage(item.messageId);
    }
  } catch (error) {
    if (shouldQueue) {
      removeQueuedSendItem(runtime, item);
    } else {
      runtime.activeSendStateByThreadId.delete(normalizedThreadId);
      await clearQueuedSendItemsForThread(runtime, item.threadId, {
        notifyCleared: true,
        noticeText: QUEUED_SEND_CLEARED_TEXT,
      });
    }
    throw error;
  }

  if (shouldQueue) {
    return normalizedThreadId;
  }

  await dispatchQueuedSendItem(runtime, item, {
    activeReserved: true,
  });
  return normalizedThreadId;
}

function handleQueuedTurnLifecycleEvent(runtime, message) {
  const method = normalizeIdentifier(message?.method);
  if (method !== "turn/started" && method !== "turn/start") {
    return;
  }

  const threadId = normalizeIdentifier(message?.params?.threadId || message?.params?.thread?.id);
  if (!threadId) {
    return;
  }

  const active = runtime.activeSendStateByThreadId.get(threadId);
  if (!active) {
    return;
  }

  active.status = "running";
  active.turnId = normalizeIdentifier(message?.params?.turnId || message?.params?.turn?.id);
  active.updatedAt = new Date().toISOString();
  runtime.activeSendStateByThreadId.set(threadId, active);
}

async function finalizeQueuedSendForThread(runtime, threadId) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!normalizedThreadId) {
    return;
  }

  const active = runtime.activeSendStateByThreadId.get(normalizedThreadId) || null;
  runtime.activeSendStateByThreadId.delete(normalizedThreadId);
  if (active?.messageId) {
    await clearPendingReactionForQueueItem(runtime, active).catch((error) => {
      console.error(`[codex-im] failed to clear queued send reaction: ${error.message}`);
    });
  }

  const queued = getQueuedSendItems(runtime, normalizedThreadId);
  if (!queued.length) {
    return;
  }

  const [next, ...rest] = queued;
  setQueuedSendItems(runtime, normalizedThreadId, rest);
  try {
    await dispatchQueuedSendItem(runtime, next);
  } catch (error) {
    if (!error?.queueDeliveryHandled) {
      console.error(`[codex-im] failed to dispatch queued send for ${normalizedThreadId}: ${error.message}`);
    }
  }
}

async function clearQueuedSendItemsForThread(runtime, threadId, {
  notifyCleared = false,
  noticeText = "",
} = {}) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!normalizedThreadId) {
    return 0;
  }

  const queued = getQueuedSendItems(runtime, normalizedThreadId);
  setQueuedSendItems(runtime, normalizedThreadId, []);
  for (const item of queued) {
    await clearPendingReactionForQueueItem(runtime, item).catch((error) => {
      console.error(`[codex-im] failed to clear queued send reaction: ${error.message}`);
    });
    if (notifyCleared && item.chatId && item.messageId && noticeText) {
      await runtime.sendInfoCardMessage({
        chatId: item.chatId,
        replyToMessageId: item.messageId,
        text: noticeText,
      }).catch((error) => {
        console.error(`[codex-im] failed to notify cleared queued send: ${error.message}`);
      });
    }
  }

  return queued.length;
}

function getQueuedSendCountForThread(runtime, threadId) {
  return getQueuedSendItems(runtime, threadId).length;
}

function getActiveSendStateForThread(runtime, threadId) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!normalizedThreadId) {
    return null;
  }
  return runtime.activeSendStateByThreadId.get(normalizedThreadId) || null;
}

function isThreadSendBusy(runtime, threadId) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!normalizedThreadId) {
    return false;
  }

  const active = runtime.activeSendStateByThreadId.get(normalizedThreadId);
  if (active && (active.status === "starting" || active.status === "running")) {
    return true;
  }

  return getQueuedSendItems(runtime, normalizedThreadId).length > 0;
}

async function dispatchQueuedSendItem(runtime, item, { activeReserved = false } = {}) {
  if (!item?.threadId) {
    return null;
  }

  if (!activeReserved) {
    setActiveSendState(runtime, item, "starting");
  }
  runtime.setPendingBindingContext(item.bindingKey, item.normalized);
  runtime.setPendingThreadContext(item.threadId, item.normalized);

  try {
    return await runtime.ensureThreadAndSendMessage({
      bindingKey: item.bindingKey,
      workspaceRoot: item.workspaceRoot,
      normalized: item.normalized,
      threadId: item.threadId,
      reviewSendOptions: item.reviewSendOptions,
    });
  } catch (error) {
    runtime.activeSendStateByThreadId.delete(item.threadId);
    await clearPendingReactionForQueueItem(runtime, item).catch((reactionError) => {
      console.error(`[codex-im] failed to clear queued send reaction: ${reactionError.message}`);
    });
    await runtime.sendInfoCardMessage({
      chatId: item.chatId,
      replyToMessageId: item.messageId,
      text: formatFailureText(item.failureTextPrefix || "处理失败", error),
    }).catch((notifyError) => {
      console.error(`[codex-im] failed to send queued dispatch failure: ${notifyError.message}`);
    });
    await clearQueuedSendItemsForThread(runtime, item.threadId, {
      notifyCleared: true,
      noticeText: QUEUED_SEND_CLEARED_TEXT,
    });
    error.queueDeliveryHandled = true;
    throw error;
  }
}

function setActiveSendState(runtime, item, status) {
  runtime.activeSendStateByThreadId.set(item.threadId, {
    status,
    threadId: item.threadId,
    messageId: item.messageId,
    turnId: "",
    enqueuedAt: item.enqueuedAt,
    updatedAt: new Date().toISOString(),
  });
}

function shouldQueueThreadSend(runtime, { normalized, threadId, reviewSendOptions = {} } = {}) {
  if (!threadId || !normalized) {
    return false;
  }
  if (reviewSendOptions.isSyntheticContinue === true) {
    return false;
  }
  if (typeof runtime.isReviewerThreadId === "function" && runtime.isReviewerThreadId(threadId)) {
    return false;
  }
  return normalizeIdentifier(normalized.provider) === "feishu";
}

async function clearPendingReactionForQueueItem(runtime, item) {
  const messageId = normalizeIdentifier(item?.messageId);
  if (!messageId) {
    return;
  }
  await runtime.clearPendingReactionForMessage(messageId);
}

function getQueuedSendItems(runtime, threadId) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!normalizedThreadId) {
    return [];
  }
  const queued = runtime.queuedSendItemsByThreadId.get(normalizedThreadId);
  return Array.isArray(queued) ? [...queued] : [];
}

function setQueuedSendItems(runtime, threadId, items) {
  const normalizedThreadId = normalizeIdentifier(threadId);
  if (!normalizedThreadId) {
    return;
  }
  if (!Array.isArray(items) || !items.length) {
    runtime.queuedSendItemsByThreadId.delete(normalizedThreadId);
    return;
  }
  runtime.queuedSendItemsByThreadId.set(normalizedThreadId, items);
}

function removeQueuedSendItem(runtime, item) {
  const queued = getQueuedSendItems(runtime, item?.threadId);
  if (!queued.length) {
    return;
  }
  const next = queued.filter((candidate) => candidate.messageId !== item.messageId);
  setQueuedSendItems(runtime, item.threadId, next);
}

function normalizeIdentifier(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

module.exports = {
  clearQueuedSendItemsForThread,
  enqueueOrDispatchThreadMessage,
  finalizeQueuedSendForThread,
  getActiveSendStateForThread,
  getQueuedSendCountForThread,
  handleQueuedTurnLifecycleEvent,
  isThreadSendBusy,
};
