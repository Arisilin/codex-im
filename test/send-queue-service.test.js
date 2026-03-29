const test = require("node:test");
const assert = require("node:assert/strict");

const {
  clearQueuedSendItemsForThread,
  enqueueOrDispatchThreadMessage,
  finalizeQueuedSendForThread,
  getActiveSendStateForThread,
  getQueuedSendCountForThread,
  handleQueuedTurnLifecycleEvent,
} = require("../src/domain/thread/send-queue-service");
const { handleStopCommand } = require("../src/app/codex-event-service");
const { handleLongCommand } = require("../src/domain/review/review-service");

function createQueueRuntime({
  ensureImpl,
} = {}) {
  const infoCards = [];
  const addedReactions = [];
  const clearedReactions = [];
  const ensureCalls = [];
  const bindingContextByBindingKey = new Map();
  const pendingChatContextByThreadId = new Map();

  const runtime = {
    queuedSendItemsByThreadId: new Map(),
    activeSendStateByThreadId: new Map(),
    pendingChatContextByBindingKey: bindingContextByBindingKey,
    pendingChatContextByThreadId,
    activeTurnIdByThreadId: new Map(),
    turnDeliveryModeByThreadId: new Map(),
    pendingReactionByMessageId: new Map(),
    isReviewerThreadId() {
      return false;
    },
    setPendingBindingContext(bindingKey, normalized) {
      bindingContextByBindingKey.set(bindingKey, normalized);
    },
    setPendingThreadContext(threadId, normalized) {
      pendingChatContextByThreadId.set(threadId, normalized);
    },
    addPendingReactionForMessage: async (messageId) => {
      addedReactions.push(messageId);
      runtime.pendingReactionByMessageId.set(messageId, {
        messageId,
        reactionId: `reaction-${messageId}`,
      });
    },
    clearPendingReactionForMessage: async (messageId) => {
      clearedReactions.push(messageId);
      runtime.pendingReactionByMessageId.delete(messageId);
    },
    ensureThreadAndSendMessage: async (payload) => {
      ensureCalls.push(payload);
      if (ensureImpl) {
        return ensureImpl(payload);
      }
      return payload.threadId;
    },
    sendInfoCardMessage: async (payload) => {
      infoCards.push(payload);
    },
    sessionStore: {
      buildBindingKey() {
        return "binding-1";
      },
    },
    resolveWorkspaceRootForBinding() {
      return "/repo";
    },
    resolveThreadIdForBinding() {
      return "thread-1";
    },
    getActiveSendStateForThread(threadId) {
      return getActiveSendStateForThread(runtime, threadId);
    },
    getQueuedSendCountForThread(threadId) {
      return getQueuedSendCountForThread(runtime, threadId);
    },
    clearQueuedSendItemsForThread: async (threadId, options) => clearQueuedSendItemsForThread(runtime, threadId, options),
  };

  return {
    runtime,
    infoCards,
    addedReactions,
    clearedReactions,
    ensureCalls,
    bindingContextByBindingKey,
    pendingChatContextByThreadId,
  };
}

function buildNormalizedMessage(messageId, text = `message-${messageId}`) {
  return {
    provider: "feishu",
    workspaceId: "default",
    chatId: "chat-1",
    threadKey: "thread-key-1",
    senderId: "user-1",
    messageId,
    text,
    command: "message",
    receivedAt: "2026-03-29T18:00:00.000Z",
  };
}

test("enqueueOrDispatchThreadMessage queues a second message while the first send is still starting", async () => {
  let resolveFirstSend = null;
  const {
    runtime,
    ensureCalls,
  } = createQueueRuntime({
    ensureImpl: async (payload) => {
      if (payload.normalized.messageId === "msg-1") {
        return new Promise((resolve) => {
          resolveFirstSend = resolve;
        });
      }
      return payload.threadId;
    },
  });

  const firstSendPromise = enqueueOrDispatchThreadMessage(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: buildNormalizedMessage("msg-1", "first"),
    threadId: "thread-1",
  });
  await Promise.resolve();

  await enqueueOrDispatchThreadMessage(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: buildNormalizedMessage("msg-2", "second"),
    threadId: "thread-1",
  });

  assert.equal(ensureCalls.length, 1);
  assert.equal(ensureCalls[0].normalized.messageId, "msg-1");
  assert.equal(getActiveSendStateForThread(runtime, "thread-1")?.status, "starting");
  assert.equal(getQueuedSendCountForThread(runtime, "thread-1"), 1);

  resolveFirstSend("thread-1");
  await firstSendPromise;
});

test("finalizeQueuedSendForThread dispatches queued messages in FIFO order and restores per-message context", async () => {
  const {
    runtime,
    ensureCalls,
    pendingChatContextByThreadId,
    clearedReactions,
  } = createQueueRuntime();

  await enqueueOrDispatchThreadMessage(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: buildNormalizedMessage("msg-1", "first"),
    threadId: "thread-1",
  });
  await enqueueOrDispatchThreadMessage(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: buildNormalizedMessage("msg-2", "second"),
    threadId: "thread-1",
  });
  await enqueueOrDispatchThreadMessage(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: buildNormalizedMessage("msg-3", "third"),
    threadId: "thread-1",
  });

  handleQueuedTurnLifecycleEvent(runtime, {
    method: "turn/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
    },
  });
  assert.equal(getActiveSendStateForThread(runtime, "thread-1")?.status, "running");

  await finalizeQueuedSendForThread(runtime, "thread-1");
  assert.deepEqual(
    ensureCalls.map((call) => call.normalized.messageId),
    ["msg-1", "msg-2"]
  );
  assert.equal(pendingChatContextByThreadId.get("thread-1")?.messageId, "msg-2");
  assert.equal(getQueuedSendCountForThread(runtime, "thread-1"), 1);

  await finalizeQueuedSendForThread(runtime, "thread-1");
  assert.deepEqual(
    ensureCalls.map((call) => call.normalized.messageId),
    ["msg-1", "msg-2", "msg-3"]
  );
  assert.equal(pendingChatContextByThreadId.get("thread-1")?.messageId, "msg-3");
  assert.equal(getQueuedSendCountForThread(runtime, "thread-1"), 0);
  assert.deepEqual(clearedReactions, ["msg-1", "msg-2"]);
});

test("finalizeQueuedSendForThread clears the remaining queue when the next queued dispatch fails before start", async () => {
  const {
    runtime,
    infoCards,
    clearedReactions,
  } = createQueueRuntime({
    ensureImpl: async (payload) => {
      if (payload.normalized.messageId === "msg-2") {
        throw new Error("rpc down");
      }
      return payload.threadId;
    },
  });

  await enqueueOrDispatchThreadMessage(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: buildNormalizedMessage("msg-1", "first"),
    threadId: "thread-1",
  });
  await enqueueOrDispatchThreadMessage(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: buildNormalizedMessage("msg-2", "second"),
    threadId: "thread-1",
  });
  await enqueueOrDispatchThreadMessage(runtime, {
    bindingKey: "binding-1",
    workspaceRoot: "/repo",
    normalized: buildNormalizedMessage("msg-3", "third"),
    threadId: "thread-1",
  });

  await finalizeQueuedSendForThread(runtime, "thread-1");

  assert.equal(getQueuedSendCountForThread(runtime, "thread-1"), 0);
  assert.equal(getActiveSendStateForThread(runtime, "thread-1"), null);
  assert.deepEqual(clearedReactions, ["msg-1", "msg-2", "msg-3"]);
  assert.deepEqual(
    infoCards.map((card) => ({ replyToMessageId: card.replyToMessageId, text: card.text })),
    [
      { replyToMessageId: "msg-2", text: "处理失败：rpc down" },
      { replyToMessageId: "msg-3", text: "前序消息启动失败，队列已清空，请重试。" },
    ]
  );
});

test("handleStopCommand cancels the active turn and clears queued messages", async () => {
  const infoCards = [];
  const cancelCalls = [];
  const runtime = {
    sessionStore: {
      buildBindingKey() {
        return "binding-1";
      },
    },
    resolveWorkspaceRootForBinding() {
      return "/repo";
    },
    resolveThreadIdForBinding() {
      return "thread-1";
    },
    getActiveSendStateForThread() {
      return { status: "running", threadId: "thread-1" };
    },
    activeTurnIdByThreadId: new Map([["thread-1", "turn-1"]]),
    getQueuedSendCountForThread() {
      return 2;
    },
    clearQueuedSendItemsForThread: async () => 2,
    codex: {
      sendRequest: async (method, payload) => {
        cancelCalls.push({ method, payload });
      },
    },
    sendInfoCardMessage: async (payload) => {
      infoCards.push(payload);
    },
  };

  await handleStopCommand(runtime, {
    chatId: "chat-1",
    messageId: "msg-stop",
  });

  assert.deepEqual(cancelCalls, [{
    method: "turn/interrupt",
    payload: {
      threadId: "thread-1",
      turnId: "turn-1",
    },
  }]);
  assert.deepEqual(infoCards, [{
    chatId: "chat-1",
    replyToMessageId: "msg-stop",
    text: "已发送停止请求，并清空 2 条排队消息。",
  }]);
});

test("handleStopCommand clears queued messages without cancelling when no active turn exists", async () => {
  const infoCards = [];
  let clearCalls = 0;
  const runtime = {
    sessionStore: {
      buildBindingKey() {
        return "binding-1";
      },
    },
    resolveWorkspaceRootForBinding() {
      return "/repo";
    },
    resolveThreadIdForBinding() {
      return "thread-1";
    },
    getActiveSendStateForThread() {
      return null;
    },
    activeTurnIdByThreadId: new Map(),
    getQueuedSendCountForThread() {
      return 2;
    },
    clearQueuedSendItemsForThread: async () => {
      clearCalls += 1;
      return 2;
    },
    codex: {
      sendRequest: async () => {
        throw new Error("should not cancel");
      },
    },
    sendInfoCardMessage: async (payload) => {
      infoCards.push(payload);
    },
  };

  await handleStopCommand(runtime, {
    chatId: "chat-1",
    messageId: "msg-stop",
  });

  assert.equal(clearCalls, 1);
  assert.deepEqual(infoCards, [{
    chatId: "chat-1",
    replyToMessageId: "msg-stop",
    text: "已清空 2 条排队消息。",
  }]);
});

test("handleLongCommand routes the prompt through the same thread queue", async () => {
  const queuedCalls = [];
  const runtime = {
    resolveWorkspaceContext: async () => ({
      bindingKey: "binding-1",
      workspaceRoot: "/repo",
    }),
    resolveWorkspaceThreadState: async () => ({
      threadId: "thread-1",
    }),
    enqueueOrDispatchThreadMessage: async (payload) => {
      queuedCalls.push(payload);
      return payload.threadId;
    },
    sendInfoCardMessage: async () => {
      throw new Error("should not send info card");
    },
  };

  await handleLongCommand(runtime, {
    provider: "feishu",
    chatId: "chat-1",
    messageId: "msg-long",
    text: "/codex long finish the report",
  });

  assert.equal(queuedCalls.length, 1);
  assert.equal(queuedCalls[0].bindingKey, "binding-1");
  assert.equal(queuedCalls[0].workspaceRoot, "/repo");
  assert.equal(queuedCalls[0].threadId, "thread-1");
  assert.equal(queuedCalls[0].normalized.text, "finish the report");
  assert.equal(queuedCalls[0].reviewSendOptions.enableLongModeForMainThread, true);
  assert.equal(queuedCalls[0].failureTextPrefix, "处理 long 模式请求失败");
});
