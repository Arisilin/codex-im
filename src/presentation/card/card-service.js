const codexMessageUtils = require("../../infra/codex/message-utils");
const messageNormalizers = require("../message/normalizers");
const reactionRepo = require("../../infra/feishu/reaction-repo");
const { formatFailureText } = require("../../shared/error-text");
const {
  buildApprovalCard,
  buildApprovalResolvedCard,
  buildAssistantReplyCard,
  buildCardResponse,
  buildInfoCard,
  mergeReplyText,
} = require("./builders");

async function sendInfoCardMessage(runtime, { chatId, text, replyToMessageId = "", replyInThread = false, kind = "info" }) {
  if (!chatId || !text) {
    return null;
  }

  return sendInteractiveCard(runtime, {
    chatId,
    replyToMessageId,
    replyInThread,
    card: buildInfoCard(text, { kind }),
  });
}

async function sendFeedbackByContext(runtime, normalized, { text, kind = "info", replyToMessageId = "" } = {}) {
  if (!normalized?.chatId || !text) {
    return null;
  }
  return sendInfoCardMessage(runtime, {
    chatId: normalized.chatId,
    replyToMessageId: replyToMessageId || normalized.messageId || "",
    text,
    kind,
  });
}

async function sendInteractiveApprovalCard(runtime, { chatId, approval, replyToMessageId = "", replyInThread = false }) {
  if (!chatId || !approval) {
    return null;
  }

  return sendInteractiveCard(runtime, {
    chatId,
    replyToMessageId,
    replyInThread,
    card: buildApprovalCard(approval),
  });
}

async function updateInteractiveCard(runtime, { messageId, approval }) {
  if (!messageId || !approval) {
    return null;
  }
  return patchInteractiveCard(runtime, {
    messageId,
    card: buildApprovalResolvedCard(approval),
  });
}

async function sendInteractiveCard(runtime, { chatId, card, replyToMessageId = "", replyInThread = false }) {
  if (!chatId || !card) {
    return null;
  }
  return runtime.requireFeishuAdapter().sendInteractiveCard({
    chatId,
    card,
    replyToMessageId,
    replyInThread,
  });
}

async function patchInteractiveCard(runtime, { messageId, card }) {
  if (!messageId || !card) {
    return null;
  }
  return runtime.requireFeishuAdapter().patchInteractiveCard({ messageId, card });
}

async function handleCardAction(runtime, data) {
  const action = messageNormalizers.extractCardAction(data);
  console.log(
    `[codex-im] card callback kind=${action?.kind || "-"} action=${action?.action || "-"} `
    + `thread=${action?.threadId || "-"} request=${action?.requestId || "-"} selected=${action?.selectedValue || "-"}`
  );
  if (!action) {
    runCardActionTask(runtime, sendCardActionFeedback(runtime, data, "无法识别卡片操作。", "error"));
    return buildCardResponse({});
  }

  if (action.kind === "approval") {
    runCardActionTask(runtime, runtime.handleApprovalCardActionAsync(action, data));
    return buildCardResponse({});
  }

  const normalized = messageNormalizers.normalizeCardActionContext(data, runtime.config);
  if (!normalized) {
    runCardActionTask(runtime, sendCardActionFeedback(runtime, data, "无法解析当前卡片上下文。", "error"));
    return buildCardResponse({});
  }

  try {
    const handled = runtime.dispatchCardAction(action, normalized);
    if (handled) {
      return handled;
    }
  } catch (error) {
    runCardActionTask(
      runtime,
      sendCardActionFeedbackByContext(runtime, normalized, formatFailureText("处理失败", error), "error")
    );
    return buildCardResponse({});
  }

  runCardActionTask(runtime, sendCardActionFeedbackByContext(runtime, normalized, "未支持的卡片操作。", "error"));
  return buildCardResponse({});
}

function queueCardActionWithFeedback(runtime, normalized, feedbackText, task) {
  runCardActionTask(runtime, (async () => {
    await sendCardActionFeedbackByContext(runtime, normalized, feedbackText, "progress");
    await task();
  })());
  return buildCardResponse({});
}

function runCardActionTask(runtime, taskPromise) {
  Promise.resolve(taskPromise).catch((error) => {
    console.error(`[codex-im] async card action failed: ${error.message}`);
  });
}

async function sendCardActionFeedbackByContext(runtime, normalized, text, kind = "info") {
  await sendFeedbackByContext(runtime, normalized, { text, kind });
}

async function sendCardActionFeedback(runtime, data, text, kind = "info") {
  const normalized = messageNormalizers.normalizeCardActionContext(data, runtime.config);
  if (!normalized) {
    return;
  }
  await sendCardActionFeedbackByContext(runtime, normalized, text, kind);
}

async function upsertAssistantReplyCard(
  runtime,
  { threadId, turnId, itemId, chatId, text, textMode = "append", state, deferFlush = false }
) {
  if (!threadId || !chatId) {
    return;
  }

  const { cardKey, entry } = resolveReplyCardEntry(runtime, {
    threadId,
    turnId,
    chatId,
  });

  if (typeof text === "string" && text.length > 0) {
    applyAssistantTextUpdate(entry, {
      itemId,
      text,
      textMode,
    });
  }

  entry.chatId = chatId;
  entry.replyToMessageId = runtime.pendingChatContextByThreadId.get(threadId)?.messageId || entry.replyToMessageId || "";
  if (state) {
    entry.state = state;
  }
  if (turnId) {
    entry.turnId = turnId;
  }

  runtime.setReplyCardEntry(cardKey, entry);
  runtime.currentReplyCardKeyByThreadId.set(threadId, cardKey);

  if (deferFlush && entry.state !== "completed" && entry.state !== "failed") {
    return;
  }

  const shouldFlushImmediately = entry.state === "completed"
    || entry.state === "failed"
    || textMode === "replace"
    || (!entry.messageId && buildReplyCardText(entry));
  await scheduleReplyCardFlush(runtime, cardKey, { immediate: shouldFlushImmediately });
}

function resolveReplyCardEntry(runtime, { threadId, turnId, chatId }) {
  const currentCardKey = runtime.currentReplyCardKeyByThreadId.get(threadId) || "";
  const currentEntry = currentCardKey ? runtime.replyCardByRunKey.get(currentCardKey) || null : null;
  if (currentEntry && !currentEntry.sealed) {
    if (turnId && !currentEntry.turnId) {
      currentEntry.turnId = turnId;
    }
    currentEntry.chatId = chatId || currentEntry.chatId || "";
    return { cardKey: currentCardKey, entry: currentEntry };
  }

  const pendingContext = runtime.pendingChatContextByThreadId.get(threadId) || null;
  const replyToMessageId = pendingContext?.messageId || "";
  const baseKey = `${threadId}:${replyToMessageId || "pending"}`;
  let cardKey = baseKey;
  let suffix = 1;
  while (runtime.replyCardByRunKey.has(cardKey) && runtime.replyCardByRunKey.get(cardKey)?.sealed) {
    suffix += 1;
    cardKey = `${baseKey}:${suffix}`;
  }

  const entry = runtime.replyCardByRunKey.get(cardKey) || {
    messageId: "",
    chatId,
    replyToMessageId,
    state: "streaming",
    threadId,
    turnId: turnId || "",
    completedItems: [],
    activeItemId: "",
    activeText: "",
    sealed: false,
  };
  entry.chatId = chatId || entry.chatId || "";
  entry.replyToMessageId = replyToMessageId || entry.replyToMessageId || "";
  entry.sealed = false;
  return { cardKey, entry };
}

function applyAssistantTextUpdate(entry, { itemId, text, textMode }) {
  const resolvedItemId = typeof itemId === "string" && itemId.trim() ? itemId.trim() : entry.activeItemId || "active";
  if (!resolvedItemId) {
    return;
  }

  if (entry.activeItemId && entry.activeItemId !== resolvedItemId) {
    finalizeActiveItem(entry);
  }

  if (!entry.activeItemId || entry.activeItemId !== resolvedItemId) {
    entry.activeItemId = resolvedItemId;
    entry.activeText = "";
  }

  if (textMode === "replace") {
    entry.activeText = text;
    finalizeActiveItem(entry);
    return;
  }

  entry.activeText = mergeReplyText(entry.activeText, text);
}

function finalizeActiveItem(entry) {
  const itemId = entry.activeItemId || "";
  const text = String(entry.activeText || "").trim();
  if (itemId && text) {
    upsertCompletedItem(entry, itemId, text);
  }
  entry.activeItemId = "";
  entry.activeText = "";
}

function upsertCompletedItem(entry, itemId, text) {
  if (!itemId || !text) {
    return;
  }

  const completedItems = Array.isArray(entry.completedItems) ? entry.completedItems : [];
  const existingIndex = completedItems.findIndex((item) => item?.itemId === itemId);
  if (existingIndex >= 0) {
    completedItems[existingIndex] = { itemId, text };
  } else {
    completedItems.push({ itemId, text });
  }
  entry.completedItems = completedItems;
}

function buildReplyCardText(entry) {
  const completed = Array.isArray(entry.completedItems)
    ? entry.completedItems.map((item) => String(item?.text || "").trim()).filter(Boolean)
    : [];
  const active = String(entry.activeText || "").trim();
  if (active) {
    completed.push(active);
  }
  return completed.join("\n\n").trim();
}

function sealCurrentReplyCard(runtime, threadId) {
  if (!threadId) {
    return;
  }
  const cardKey = runtime.currentReplyCardKeyByThreadId.get(threadId) || "";
  if (!cardKey) {
    return;
  }
  const entry = runtime.replyCardByRunKey.get(cardKey);
  if (entry) {
    finalizeActiveItem(entry);
    entry.sealed = true;
    runtime.setReplyCardEntry(cardKey, entry);
  }
  runtime.currentReplyCardKeyByThreadId.delete(threadId);
}

async function scheduleReplyCardFlush(runtime, runKey, { immediate = false } = {}) {
  const entry = runtime.replyCardByRunKey.get(runKey);
  if (!entry) {
    return;
  }

  if (immediate) {
    clearReplyFlushTimer(runtime, runKey);
    await enqueueReplyCardFlush(runtime, runKey);
    return;
  }

  if (runtime.replyFlushTimersByRunKey.has(runKey)) {
    return;
  }

  const timer = setTimeout(() => {
    runtime.replyFlushTimersByRunKey.delete(runKey);
    enqueueReplyCardFlush(runtime, runKey).catch((error) => {
      console.error(`[codex-im] failed to flush reply card: ${error.message}`);
    });
  }, 300);
  runtime.replyFlushTimersByRunKey.set(runKey, timer);
}

function enqueueReplyCardFlush(runtime, runKey) {
  const previous = runtime.replyFlushLocksByRunKey.get(runKey) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => flushReplyCard(runtime, runKey))
    .finally(() => {
      if (runtime.replyFlushLocksByRunKey.get(runKey) === next) {
        runtime.replyFlushLocksByRunKey.delete(runKey);
      }
    });
  runtime.replyFlushLocksByRunKey.set(runKey, next);
  return next;
}

function clearReplyFlushTimer(runtime, runKey) {
  const timer = runtime.replyFlushTimersByRunKey.get(runKey);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  runtime.replyFlushTimersByRunKey.delete(runKey);
}

async function flushReplyCard(runtime, runKey) {
  const entry = runtime.replyCardByRunKey.get(runKey);
  if (!entry) {
    return;
  }

  const card = buildAssistantReplyCard({
    text: buildReplyCardText(entry),
    state: entry.state,
  });

  if (!entry.messageId) {
    const response = await sendInteractiveCard(runtime, {
      chatId: entry.chatId,
      card,
      replyToMessageId: entry.replyToMessageId,
    });
    entry.messageId = codexMessageUtils.extractCreatedMessageId(response);
    if (!entry.messageId) {
      return;
    }
    runtime.setReplyCardEntry(runKey, entry);
    runtime.clearPendingReactionForThread(entry.threadId).catch((error) => {
      console.error(`[codex-im] failed to clear pending reaction after first reply card: ${error.message}`);
    });
    return;
  }

  await patchInteractiveCard(runtime, {
    messageId: entry.messageId,
    card,
  });
}

async function addPendingReaction(runtime, bindingKey, messageId) {
  if (!bindingKey || !messageId) {
    return;
  }

  const existing = runtime.pendingReactionByBindingKey.get(bindingKey);
  if (existing?.messageId === messageId) {
    return;
  }

  await clearPendingReactionForBinding(runtime, bindingKey);

  const reaction = await createReaction(runtime, {
    messageId,
    emojiType: "Typing",
  });
  runtime.pendingReactionByBindingKey.set(bindingKey, {
    messageId,
    reactionId: reaction.reactionId,
  });
}

function movePendingReactionToThread(runtime, bindingKey, threadId) {
  if (!bindingKey || !threadId) {
    return;
  }

  const pending = runtime.pendingReactionByBindingKey.get(bindingKey);
  if (!pending) {
    return;
  }
  runtime.pendingReactionByBindingKey.delete(bindingKey);
  runtime.pendingReactionByThreadId.set(threadId, pending);
}

async function clearPendingReactionForBinding(runtime, bindingKey) {
  const pending = runtime.pendingReactionByBindingKey.get(bindingKey);
  if (!pending) {
    return;
  }
  runtime.pendingReactionByBindingKey.delete(bindingKey);
  await deleteReaction(runtime, pending);
}

async function clearPendingReactionForThread(runtime, threadId) {
  if (!threadId) {
    return;
  }
  const pending = runtime.pendingReactionByThreadId.get(threadId);
  if (!pending) {
    return;
  }
  runtime.pendingReactionByThreadId.delete(threadId);
  await deleteReaction(runtime, pending);
}

async function createReaction(runtime, { messageId, emojiType }) {
  return reactionRepo.createReaction(runtime.requireFeishuAdapter(), { messageId, emojiType });
}

async function deleteReaction(runtime, { messageId, reactionId }) {
  await reactionRepo.deleteReaction(runtime.requireFeishuAdapter(), { messageId, reactionId });
}

function disposeReplyRunState(runtime, runKey, threadId) {
  if (runKey) {
    clearReplyFlushTimer(runtime, runKey);
    runtime.replyFlushLocksByRunKey.delete(runKey);
    runtime.replyCardByRunKey.delete(runKey);
  }
  if (threadId && runtime.currentReplyCardKeyByThreadId.get(threadId) === runKey) {
    runtime.currentReplyCardKeyByThreadId.delete(threadId);
  }
  if (threadId && runtime.currentRunKeyByThreadId.get(threadId) === runKey) {
    runtime.currentRunKeyByThreadId.delete(threadId);
  }
}


module.exports = {
  addPendingReaction,
  clearPendingReactionForBinding,
  clearPendingReactionForThread,
  disposeReplyRunState,
  handleCardAction,
  movePendingReactionToThread,
  patchInteractiveCard,
  queueCardActionWithFeedback,
  runCardActionTask,
  sealCurrentReplyCard,
  sendCardActionFeedback,
  sendCardActionFeedbackByContext,
  sendInfoCardMessage,
  sendInteractiveApprovalCard,
  sendInteractiveCard,
  updateInteractiveCard,
  upsertAssistantReplyCard,
};
