<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import RecordingPagePreview from "../recording/RecordingPagePreview.vue";
import RecordingFlowGraph from "../recording/RecordingFlowGraph.vue";
import RecordingNodeInspector from "../recording/RecordingNodeInspector.vue";
import type { BrowserTab, InsertRecordedActionDraft, RecordedAction } from "../../types/automation";
import {
  useRecording,
  type PaginationLoopPreview,
  type RecordingPhase,
  type SavedRecordingScript,
} from "../../composables/useRecording";

const props = withDefaults(
  defineProps<{
    tab: Readonly<BrowserTab>;
    executionActive?: boolean;
    autoStart?: boolean;
  }>(),
  {
    executionActive: false,
    autoStart: true,
  },
);

const emit = defineEmits<{
  close: [];
  "active-change": [active: boolean, recordingId: string | null];
  "can-close-change": [canClose: boolean];
  saved: [result: SavedRecordingScript];
}>();

const {
  session,
  pages,
  actions,
  phase,
  operation,
  isActive,
  canStart,
  canStop,
  canUpdateActions,
  canMutateActions,
  canConfigurePaginationLoop,
  canCreateManualStep,
  canGenerate,
  canValidateAndSave,
  errorMessage,
  streamConnected,
  streamWarning,
  generatedScript,
  validationResult,
  savedScript,
  pendingActionIds,
  hasPendingActionUpdates,
  startRecording,
  setActionIncluded,
  insertAction,
  deleteAction,
  previewPaginationLoop,
  createPaginationLoop,
  dissolvePaginationLoop,
  createManualStep,
  stopRecording,
  generateScript,
  validateAndSave,
  isActionPending,
  clearError,
} = useRecording();

type InsertRecordedActionType = InsertRecordedActionDraft["type"];

const filename = ref(`recording-tab-${props.tab.index + 1}.mjs`);
const loopStartActionId = ref("");
const loopEntryActionId = ref("");
const loopNextActionId = ref("");
const loopMaxPages = ref(100);
const loopPreview = ref<PaginationLoopPreview | null>(null);
const selectedLoopCandidateIndex = ref<number | null>(null);
const selectedActionIds = ref<Set<string>>(new Set());
const manualStepTitle = ref("");
const focusedNodeId = ref<string | null>("recording-start");
const activePageId = ref<string | null>("page0");
const outputDrawerOpen = ref(false);
const actionEditorOpen = ref(false);
const actionEditorAfterActionId = ref<string | null>(null);
const actionDraftType = ref<InsertRecordedActionType>("click");
const actionDraftSelector = ref("");
const actionDraftValue = ref("");
const actionDraftChecked = ref(true);
const deletingActionId = ref<string | null>(null);
let loopPreviewGeneration = 0;
let startTask: Promise<void> | null = null;
let stopTask: ReturnType<typeof stopRecording> | null = null;

const PHASE_LABELS: Record<RecordingPhase, string> = {
  idle: "等待开始",
  starting: "正在启动",
  recording: "录制中",
  stopping: "正在停止",
  stopped: "已停止",
  "mutating-actions": "正在更新流程",
  "configuring-loop": "正在配置循环",
  generating: "正在生成",
  generated: "代码已生成",
  validating: "正在校验",
  invalid: "校验未通过",
  validated: "校验通过",
  saving: "正在保存",
  saved: "已保存",
};

const phaseLabel = computed(() => PHASE_LABELS[phase.value]);
const phaseTone = computed(() => {
  if (phase.value === "recording" || phase.value === "starting") return "live";
  if (phase.value === "invalid") return "danger";
  if (phase.value === "saved" || phase.value === "validated") return "success";
  if (phase.value === "stopped" || phase.value === "generated") return "ready";
  return "neutral";
});
const canClose = computed(
  () => !isActive.value && operation.value === "idle" && !hasPendingActionUpdates.value,
);
const focusedAction = computed(
  () => actions.value.find((action) => action.id === focusedNodeId.value) ?? null,
);
const focusedPage = computed(
  () =>
    pages.value.find((page) => page.id === (focusedAction.value?.pageId ?? activePageId.value)) ??
    null,
);
const targetLabel = computed(() => props.tab.title || props.tab.url);
const includedActions = computed(() =>
  actions.value.filter((action) => action.included && action.type !== "manualStep"),
);
const hasLoopDraft = computed(
  () =>
    Boolean(loopStartActionId.value) ||
    Boolean(loopEntryActionId.value) ||
    Boolean(loopNextActionId.value) ||
    loopPreview.value !== null,
);
const actionMutationActive = computed(
  () => actionEditorOpen.value || deletingActionId.value !== null,
);
const canOpenActionMutation = computed(
  () =>
    canMutateActions.value &&
    !actionMutationActive.value &&
    !hasLoopDraft.value &&
    selectedActionIds.value.size === 0,
);
const actionMutationHint = computed(() => {
  if (session.value?.status !== "stopped") return "请先停止录制，再新增或删除动作。";
  if (session.value.paginationLoop) return "请先解散分页循环，再修改动作结构。";
  if (hasPendingActionUpdates.value || operation.value !== "idle") {
    return "请等待当前操作完成。";
  }
  if (selectedActionIds.value.size > 0) return "请先清除人工步骤范围选择。";
  if (hasLoopDraft.value) return "请先清空分页循环草稿。";
  return "新增和删除由服务端重排步骤；成功后需重新生成代码。";
});
const canEditLoopDraft = computed(
  () =>
    canConfigurePaginationLoop.value &&
    selectedActionIds.value.size === 0 &&
    !actionMutationActive.value,
);
const isLoopMember = (action: RecordedAction): boolean =>
  session.value?.paginationLoop?.actionIds.includes(action.id) ?? false;
const loopNextOptions = computed(() => {
  const startIndex = actions.value.findIndex((action) => action.id === loopStartActionId.value);
  if (startIndex < 0) return [];
  return actions.value
    .slice(startIndex + 1)
    .filter((action) => action.included && action.type === "click" && action.selector);
});
const selectedLoopActions = computed(() => {
  const startIndex = actions.value.findIndex((action) => action.id === loopStartActionId.value);
  const nextIndex = actions.value.findIndex((action) => action.id === loopNextActionId.value);
  if (startIndex < 0 || nextIndex <= startIndex) return [];
  const range = actions.value.slice(startIndex, nextIndex + 1);
  return range.every((action) => action.included && action.type !== "manualStep") ? range : [];
});
const loopEntryOptions = computed(() =>
  selectedLoopActions.value
    .slice(0, -1)
    .filter((action) => action.type === "click" && action.selector),
);
const canPreviewLoop = computed(
  () =>
    canEditLoopDraft.value &&
    !session.value?.paginationLoop &&
    selectedLoopActions.value.length >= 2 &&
    loopEntryOptions.value.some((action) => action.id === loopEntryActionId.value),
);
const canCreateLoop = computed(
  () =>
    canEditLoopDraft.value &&
    loopPreview.value !== null &&
    selectedLoopCandidateIndex.value !== null &&
    loopPreview.value.candidates.some(
      (candidate) => candidate.candidateIndex === selectedLoopCandidateIndex.value,
    ) &&
    Number.isInteger(loopMaxPages.value) &&
    loopMaxPages.value >= 1 &&
    loopMaxPages.value <= 1000,
);
const selectedActions = computed(() =>
  actions.value.filter((action) => selectedActionIds.value.has(action.id)),
);
const selectedRangeIsContiguous = computed(() => {
  if (selectedActions.value.length === 0) return false;
  const positions = selectedActions.value.map((selected) =>
    actions.value.findIndex((action) => action.id === selected.id),
  );
  return positions.every((position, index) => position === positions[0] + index);
});
const selectedRangeIsSafe = computed(
  () =>
    selectedActions.value.length > 0 &&
    selectedRangeIsContiguous.value &&
    selectedActions.value.every(
      (action) =>
        action.included &&
        !action.opensPageId &&
        !isLoopMember(action) &&
        action.pageId === selectedActions.value[0]?.pageId &&
        !isActionPending(action.id),
    ),
);
const canConvertControls = computed(
  () =>
    !actionMutationActive.value &&
    canCreateManualStep.value &&
    selectedRangeIsSafe.value &&
    selectedActions.value.every((action) =>
      ["fill", "select", "setChecked", "manualStep"].includes(action.type),
    ),
);
const canConvertCustom = computed(
  () =>
    !actionMutationActive.value &&
    canCreateManualStep.value &&
    selectedRangeIsSafe.value &&
    selectedActions.value.every(
      (action) => action.type !== "manualStep" && typeof action.selector === "string",
    ),
);
const selectionHint = computed(() => {
  if (selectedActions.value.length === 0) {
    return hasLoopDraft.value
      ? "完成或清空分页循环配置后，才能选择人工 checkpoint。"
      : "勾选连续步骤后，可转换为一个人工 checkpoint。";
  }
  if (!selectedRangeIsContiguous.value) return "所选动作必须在流程中连续。";
  if (!selectedRangeIsSafe.value) {
    return "所选动作必须启用、位于同一页面，且不能属于循环或打开 popup。";
  }
  if (!canConvertControls.value && !canConvertCustom.value) {
    return "控件组仅支持输入/选择/勾选；自定义范围内每步都需要 selector。";
  }
  return `已选择 ${selectedActions.value.length} 个连续动作。请求只发送动作 ID，不发送 selector 或值。`;
});

const isActionSelectable = (action: RecordedAction): boolean =>
  session.value?.status === "stopped" &&
  canCreateManualStep.value &&
  !actionMutationActive.value &&
  !hasLoopDraft.value &&
  !isLoopMember(action) &&
  action.included &&
  !action.opensPageId &&
  (action.type === "manualStep" || typeof action.selector === "string");

const selectedActionIdList = computed(() => [...selectedActionIds.value]);
const selectableActionIds = computed(() =>
  actions.value.filter(isActionSelectable).map((action) => action.id),
);
const configuredLoopActions = computed(() => {
  const loop = session.value?.paginationLoop;
  if (!loop) return [];
  const loopIds = new Set(loop.actionIds);
  return actions.value.filter((action) => loopIds.has(action.id));
});
const actionEditorPageId = computed(() => {
  if (actionEditorAfterActionId.value === null) return pages.value[0]?.id ?? "page0";
  return (
    actions.value.find((action) => action.id === actionEditorAfterActionId.value)?.pageId ?? "page0"
  );
});
const actionDraftValid = computed(() => {
  const selector = actionDraftSelector.value.trim();
  switch (actionDraftType.value) {
    case "click":
    case "fill":
    case "select":
    case "setChecked":
      return Boolean(selector);
    case "press":
      return Boolean(actionDraftValue.value.trim());
    case "scroll":
      return (
        actionDraftValue.value.trim() !== "" && Number.isFinite(Number(actionDraftValue.value))
      );
  }
});
const actionEditor = computed(() => ({
  open: actionEditorOpen.value,
  canOpen: canOpenActionMutation.value,
  busy: actionEditorOpen.value && operation.value === "mutating-actions",
  anchorActionId: actionEditorAfterActionId.value,
  pageId: actionEditorPageId.value,
  type: actionDraftType.value,
  selector: actionDraftSelector.value,
  value: actionDraftValue.value,
  checked: actionDraftChecked.value,
  canSubmit:
    actionEditorOpen.value &&
    canMutateActions.value &&
    actionDraftValid.value &&
    (actionEditorAfterActionId.value === null ||
      actions.value.some((action) => action.id === actionEditorAfterActionId.value)),
  hint: actionMutationHint.value,
}));
const actionDeleteLockReason = (action: RecordedAction | null): string => {
  if (!action) return "请选择要删除的动作节点。";
  if (session.value?.status !== "stopped") return "请先停止录制，再删除动作。";
  if (session.value.paginationLoop) return "请先解散分页循环，再删除动作。";
  if (action.opensPageId) return "该节点负责打开 popup，当前版本不支持直接删除。";
  if (hasPendingActionUpdates.value || operation.value !== "idle") return "请等待当前操作完成。";
  if (actionMutationActive.value) return "请先完成当前流程编辑。";
  if (selectedActionIds.value.size > 0) return "请先清除人工步骤范围选择。";
  if (hasLoopDraft.value) return "请先清空分页循环草稿。";
  return "";
};
const actionDelete = computed(() => {
  const reason = actionDeleteLockReason(focusedAction.value);
  return {
    confirmingActionId: deletingActionId.value,
    canDelete: Boolean(focusedAction.value) && reason === "" && canMutateActions.value,
    busy: deletingActionId.value !== null && operation.value === "mutating-actions",
    hint: reason || "删除后会由服务端重新排列步骤编号。",
  };
});
const manualEditor = computed(() => ({
  visible: session.value?.status === "stopped",
  title: manualStepTitle.value,
  selectionHint: selectionHint.value,
  selectedCount: selectedActions.value.length,
  titleDisabled: !canCreateManualStep.value || hasLoopDraft.value || actionMutationActive.value,
  canConvertControls: canConvertControls.value,
  canConvertCustom: canConvertCustom.value,
  clearDisabled: hasPendingActionUpdates.value || actionMutationActive.value,
}));
const loopEditor = computed(() => ({
  visible: session.value?.status === "stopped" && !session.value.paginationLoop,
  canEdit: canEditLoopDraft.value,
  busy: operation.value === "configuring-loop",
  startActionId: loopStartActionId.value,
  nextActionId: loopNextActionId.value,
  entryActionId: loopEntryActionId.value,
  maxPages: loopMaxPages.value,
  startOptions: includedActions.value,
  nextOptions: loopNextOptions.value,
  entryOptions: loopEntryOptions.value,
  selectedActions: selectedLoopActions.value,
  candidates: loopPreview.value?.candidates ?? [],
  selectedCandidateIndex: selectedLoopCandidateIndex.value,
  canPreview: canPreviewLoop.value,
  canCreate: canCreateLoop.value,
  configuredActions: configuredLoopActions.value,
  canConfigure: canConfigurePaginationLoop.value,
}));

const clearActionSelection = (): void => {
  selectedActionIds.value = new Set();
};

const handleActionSelected = (actionId: string, selected: boolean): void => {
  const action = actions.value.find((candidate) => candidate.id === actionId);
  if (!action || (selected && !isActionSelectable(action))) return;
  const next = new Set(selectedActionIds.value);
  if (selected) next.add(actionId);
  else next.delete(actionId);
  selectedActionIds.value = next;
};

const handleActionIncluded = async (actionId: string, included: boolean): Promise<void> => {
  const action = actions.value.find((candidate) => candidate.id === actionId);
  if (!action || !canUpdateActions.value || isActionPending(actionId) || isLoopMember(action)) {
    return;
  }
  await setActionIncluded(actionId, included);
};

const handleFlowFocus = (nodeId: string): void => {
  if (deletingActionId.value && nodeId !== deletingActionId.value) return;
  focusedNodeId.value = nodeId;
  const action = actions.value.find((candidate) => candidate.id === nodeId);
  if (action) activePageId.value = action.pageId;
  if (nodeId === "pagination-loop") {
    const firstLoopActionId = session.value?.paginationLoop?.actionIds[0];
    const firstLoopAction = actions.value.find((candidate) => candidate.id === firstLoopActionId);
    if (firstLoopAction) activePageId.value = firstLoopAction.pageId;
  }
};

const handlePageFocus = (pageId: string): void => {
  if (deletingActionId.value) return;
  activePageId.value = pageId;
  focusedNodeId.value = null;
};

const resetActionDraft = (): void => {
  actionDraftType.value = "click";
  actionDraftSelector.value = "";
  actionDraftValue.value = "";
  actionDraftChecked.value = true;
};

const closeActionEditor = (): void => {
  actionEditorOpen.value = false;
  actionEditorAfterActionId.value = null;
  resetActionDraft();
};

const handleOpenActionInsert = (afterActionId: string | null): void => {
  if (
    !canOpenActionMutation.value ||
    (afterActionId !== null && !actions.value.some((action) => action.id === afterActionId))
  ) {
    return;
  }

  resetActionDraft();
  actionEditorAfterActionId.value = afterActionId;
  actionEditorOpen.value = true;
  focusedNodeId.value = afterActionId ?? "recording-start";
  activePageId.value = actionEditorPageId.value;
};

const handleCancelActionInsert = (): void => {
  if (operation.value === "mutating-actions") return;
  closeActionEditor();
};

const buildActionDraft = (): InsertRecordedActionDraft | null => {
  if (!actionDraftValid.value) return null;
  const selector = actionDraftSelector.value.trim();
  switch (actionDraftType.value) {
    case "click":
      return { type: "click", selector };
    case "fill":
      return { type: "fill", selector, value: actionDraftValue.value };
    case "select":
      return { type: "select", selector, value: actionDraftValue.value };
    case "setChecked":
      return { type: "setChecked", selector, value: actionDraftChecked.value };
    case "press":
      return { type: "press", value: actionDraftValue.value.trim() };
    case "scroll":
      return { type: "scroll", value: Number(actionDraftValue.value) };
  }
};

const handleSubmitActionInsert = async (): Promise<void> => {
  const draft = buildActionDraft();
  if (!draft || !actionEditor.value.canSubmit) return;
  const inserted = await insertAction(actionEditorAfterActionId.value, draft);
  if (!inserted) return;

  closeActionEditor();
  focusedNodeId.value = inserted.id;
  activePageId.value = inserted.pageId;
};

const handleRequestActionDelete = (actionId: string): void => {
  const action = actions.value.find((candidate) => candidate.id === actionId) ?? null;
  if (
    !action ||
    focusedAction.value?.id !== action.id ||
    actionDeleteLockReason(action) ||
    !canMutateActions.value
  ) {
    return;
  }
  deletingActionId.value = action.id;
  focusedNodeId.value = action.id;
  activePageId.value = action.pageId;
};

const handleCancelActionDelete = (): void => {
  if (operation.value === "mutating-actions") return;
  deletingActionId.value = null;
};

const handleConfirmActionDelete = async (): Promise<void> => {
  const actionId = deletingActionId.value;
  if (!actionId || operation.value !== "idle") return;
  const ordered = [...actions.value].sort((left, right) => left.order - right.order);
  const actionIndex = ordered.findIndex((action) => action.id === actionId);
  if (actionIndex < 0) return;
  const nextFocusId =
    ordered[actionIndex + 1]?.id ?? ordered[actionIndex - 1]?.id ?? "recording-start";

  const deleted = await deleteAction(actionId);
  if (!deleted) return;

  focusedNodeId.value = deleted.actions.some((action) => action.id === nextFocusId)
    ? nextFocusId
    : "recording-start";
  const focused = deleted.actions.find((action) => action.id === focusedNodeId.value);
  activePageId.value = focused?.pageId ?? deleted.pages[0]?.id ?? "page0";
  deletingActionId.value = null;
};

const handleCreateManualStep = async (mode: "controls" | "custom"): Promise<void> => {
  const result = await createManualStep({
    actionIds: selectedActions.value.map((action) => action.id),
    mode,
    ...(manualStepTitle.value.trim() ? { title: manualStepTitle.value.trim() } : {}),
  });
  if (result) {
    clearActionSelection();
    manualStepTitle.value = "";
  }
};

const handleStart = (): Promise<void> => {
  if (startTask) return startTask;
  if (props.executionActive || !canStart.value) return Promise.resolve();
  const task = (async () => {
    clearError();
    await startRecording({
      index: props.tab.index,
      targetId: props.tab.targetId,
      url: props.tab.url,
    });
  })();
  startTask = task;
  void task.finally(() => {
    if (startTask === task) startTask = null;
  });
  return task;
};

const handleStop = (): ReturnType<typeof stopRecording> => {
  if (stopTask) return stopTask;
  const task = stopRecording();
  stopTask = task;
  void task.finally(() => {
    if (stopTask === task) stopTask = null;
  });
  return task;
};

const stopForNavigation = async (): Promise<boolean> => {
  await startTask;
  if (session.value?.status !== "recording") return true;
  const stopped = await handleStop();
  return stopped?.status === "stopped" || session.value?.status === "stopped";
};

defineExpose({ stopForNavigation });

const invalidateLoopPreview = (): void => {
  loopPreviewGeneration += 1;
  loopPreview.value = null;
  selectedLoopCandidateIndex.value = null;
};

const resetLoopForm = (): void => {
  loopStartActionId.value = "";
  loopEntryActionId.value = "";
  loopNextActionId.value = "";
  loopMaxPages.value = 100;
  invalidateLoopPreview();
};

const currentLoopSelection = () => {
  if (!canPreviewLoop.value) return null;
  return {
    actionIds: selectedLoopActions.value.map((action) => action.id),
    listEntryActionId: loopEntryActionId.value,
    nextActionId: loopNextActionId.value,
  };
};

const handlePreviewLoop = async (): Promise<void> => {
  const selection = currentLoopSelection();
  if (!selection) return;
  invalidateLoopPreview();
  const generation = loopPreviewGeneration;
  const recordingId = session.value?.id;
  const actionSnapshot = actions.value;
  const preview = await previewPaginationLoop(selection);
  if (
    !preview ||
    generation !== loopPreviewGeneration ||
    session.value?.id !== recordingId ||
    actions.value !== actionSnapshot
  ) {
    return;
  }
  loopPreview.value = preview;
  if (preview.candidates.length === 1) {
    selectedLoopCandidateIndex.value = preview.candidates[0]?.candidateIndex ?? null;
  }
};

const handleCreateLoop = async (): Promise<void> => {
  const preview = loopPreview.value;
  const candidate = preview?.candidates.find(
    (item) => item.candidateIndex === selectedLoopCandidateIndex.value,
  );
  if (!preview || !candidate || !canCreateLoop.value) return;
  const created = await createPaginationLoop({
    actionIds: [...preview.actionIds],
    listEntryActionId: preview.listEntryActionId,
    nextActionId: preview.nextActionId,
    candidateIndex: candidate.candidateIndex,
    maxPages: loopMaxPages.value,
  });
  if (created) {
    clearActionSelection();
    resetLoopForm();
  }
};

const handleDissolveLoop = async (reconfigure: boolean): Promise<void> => {
  const configuredLoop = session.value?.paginationLoop;
  if (!configuredLoop) return;
  const previous = {
    startActionId: configuredLoop.actionIds[0] ?? "",
    listEntryActionId: configuredLoop.listEntryActionId,
    nextActionId: configuredLoop.nextActionId,
    maxPages: configuredLoop.maxPages,
  };
  const dissolved = await dissolvePaginationLoop();
  if (!dissolved) return;
  resetLoopForm();
  if (reconfigure) {
    loopStartActionId.value = previous.startActionId;
    loopEntryActionId.value = previous.listEntryActionId;
    loopNextActionId.value = previous.nextActionId;
    loopMaxPages.value = previous.maxPages;
  }
};

const handleGenerate = async (): Promise<void> => {
  const generated = await generateScript(filename.value);
  if (!generated) return;
  filename.value = generated.filename;
  outputDrawerOpen.value = true;
};

const handleValidateAndSave = async (): Promise<void> => {
  const result = await validateAndSave(
    `浏览器录制：${generatedScript.value?.filename ?? filename.value.trim()}`,
  );
  if (result) emit("saved", result);
};

watch([loopStartActionId, loopNextActionId, loopEntryActionId], () => {
  if (
    loopNextActionId.value &&
    !loopNextOptions.value.some((action) => action.id === loopNextActionId.value)
  ) {
    loopNextActionId.value = "";
  }
  if (
    loopEntryActionId.value &&
    !loopEntryOptions.value.some((action) => action.id === loopEntryActionId.value)
  ) {
    loopEntryActionId.value = "";
  }
  invalidateLoopPreview();
});

watch(actions, (nextActions) => {
  const existingIds = new Set(nextActions.map((action) => action.id));
  const nextSelection = new Set(
    [...selectedActionIds.value].filter((actionId) => existingIds.has(actionId)),
  );
  if (nextSelection.size !== selectedActionIds.value.size) selectedActionIds.value = nextSelection;
  if (
    focusedNodeId.value &&
    !["recording-start", "pagination-loop"].includes(focusedNodeId.value) &&
    !existingIds.has(focusedNodeId.value) &&
    deletingActionId.value !== focusedNodeId.value
  ) {
    focusedNodeId.value = nextActions.at(-1)?.id ?? "recording-start";
  }
  if (
    actionEditorOpen.value &&
    actionEditorAfterActionId.value !== null &&
    !existingIds.has(actionEditorAfterActionId.value)
  ) {
    closeActionEditor();
  }
  invalidateLoopPreview();
});

watch(session, (nextSession) => {
  invalidateLoopPreview();
  if (!nextSession || nextSession.status !== "stopped" || nextSession.paginationLoop) {
    closeActionEditor();
    deletingActionId.value = null;
  }
});

watch(
  () => session.value?.paginationLoop ?? null,
  (paginationLoop) => {
    if (paginationLoop) clearActionSelection();
  },
);

watch(generatedScript, (generated) => {
  if (!generated) outputDrawerOpen.value = false;
});

watch(
  [isActive, () => session.value?.id ?? null],
  ([active, recordingId]) => emit("active-change", active, recordingId),
  { immediate: true },
);

watch(canClose, (value) => emit("can-close-change", value), { immediate: true });

onMounted(() => {
  if (props.autoStart) void handleStart();
});
</script>

<template>
  <section class="recording-panel" aria-labelledby="recording-panel-title">
    <header class="panel-header">
      <div class="header-copy">
        <div class="eyebrow-row">
          <span class="eyebrow">浏览器录制</span>
          <span class="status-badge" :class="`status-${phaseTone}`">
            <span class="status-dot" aria-hidden="true"></span>
            {{ phaseLabel }}
          </span>
        </div>
        <h3 id="recording-panel-title">{{ targetLabel }}</h3>
        <p :title="props.tab.url">Tab #{{ props.tab.index + 1 }} · {{ props.tab.url }}</p>
      </div>
      <button
        type="button"
        class="close-button"
        :disabled="!canClose"
        :title="
          canClose
            ? '关闭录制面板'
            : hasPendingActionUpdates
              ? '请等待动作同步完成'
              : operation !== 'idle'
                ? '请等待当前操作完成'
                : '请先停止录制'
        "
        aria-label="关闭录制面板"
        @click="emit('close')"
      >
        ×
      </button>
    </header>

    <div v-if="errorMessage" class="message-banner error-banner" role="alert">
      <div>
        <strong>操作未完成</strong>
        <p>{{ errorMessage }}</p>
      </div>
      <button type="button" aria-label="关闭错误提示" @click="clearError">×</button>
    </div>

    <div v-if="!session" class="empty-state">
      <div class="empty-mark" aria-hidden="true"><span></span></div>
      <div class="empty-copy">
        <h4>{{ operation === "starting" ? "正在连接录制服务" : "准备记录页面操作" }}</h4>
        <p v-if="props.executionActive">当前有脚本正在执行。请等待执行结束，再开始录制这个页签。</p>
        <p v-else>
          录制会实时收集点击、输入、选择、按键、滚动和 popup 页面操作；刷新后不会恢复本次会话。
        </p>
      </div>
      <button
        v-if="operation !== 'starting'"
        type="button"
        class="primary-button"
        :disabled="props.executionActive || !canStart"
        @click="handleStart"
      >
        开始录制
      </button>
      <span v-else class="inline-loader" role="status">正在启动…</span>
    </div>

    <template v-else>
      <div class="session-toolbar">
        <div class="session-summary">
          <div class="live-state">
            <span
              class="live-indicator"
              :class="{ pulsing: session.status === 'recording' }"
            ></span>
            <div>
              <strong>{{ session.status === "recording" ? "正在捕获操作" : "录制已停止" }}</strong>
              <span>
                {{ pages.length }} 个页面 · {{ actions.length }} 个动作
                <template v-if="hasPendingActionUpdates"> · 正在同步动作</template>
              </span>
            </div>
          </div>
          <span
            v-if="session.status === 'recording'"
            class="stream-state"
            :class="{ connected: streamConnected, warning: streamWarning }"
          >
            {{
              streamConnected
                ? "录制事件流已连接"
                : streamWarning
                  ? "录制事件流重连中"
                  : "录制事件流连接中"
            }}
          </span>
        </div>

        <div class="session-actions">
          <label class="toolbar-filename">
            <span>脚本文件</span>
            <input
              v-model.trim="filename"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="recorded-flow.mjs"
              :disabled="operation !== 'idle' || generatedScript !== null"
              data-cy="recording-filename"
            />
          </label>
          <button
            type="button"
            class="primary-button toolbar-button"
            :disabled="!canGenerate || !filename.trim()"
            data-cy="recording-generate"
            @click="handleGenerate"
          >
            {{ operation === "generating" ? "生成中…" : "生成 JS" }}
          </button>
          <button
            type="button"
            class="secondary-toolbar-button toolbar-button"
            :disabled="!generatedScript"
            data-cy="recording-view-output"
            @click="outputDrawerOpen = true"
          >
            查看代码
          </button>
          <button
            v-if="session.status === 'recording'"
            type="button"
            class="stop-button toolbar-button"
            :disabled="!canStop"
            @click="handleStop"
          >
            {{ operation === "stopping" ? "正在停止…" : "停止录制" }}
          </button>
        </div>
      </div>

      <p v-if="streamWarning" class="stream-warning" role="status">{{ streamWarning }}</p>

      <div class="visual-workspace">
        <RecordingFlowGraph
          :pages="pages"
          :actions="actions"
          :pagination-loop="session.paginationLoop"
          :focused-node-id="focusedNodeId"
          :recording="session.status === 'recording'"
          :selected-action-ids="selectedActionIdList"
          :selectable-action-ids="selectableActionIds"
          :pending-action-ids="pendingActionIds"
          :can-update-actions="canUpdateActions"
          :can-mutate-actions="canOpenActionMutation"
          @focus-node="handleFlowFocus"
          @insert-after="handleOpenActionInsert"
          @update-action-included="handleActionIncluded"
          @update-action-selected="handleActionSelected"
        />

        <RecordingPagePreview
          :pages="pages"
          :active-page-id="activePageId"
          @select-page="handlePageFocus"
        />

        <RecordingNodeInspector
          :focused-node-id="focusedNodeId"
          :action="focusedAction"
          :page="focusedPage"
          :pagination-loop="session.paginationLoop"
          :include-disabled="
            !focusedAction ||
            !canUpdateActions ||
            isActionPending(focusedAction.id) ||
            isLoopMember(focusedAction)
          "
          :include-pending="Boolean(focusedAction && isActionPending(focusedAction.id))"
          :manual-selected="Boolean(focusedAction && selectedActionIds.has(focusedAction.id))"
          :manual-selectable="Boolean(focusedAction && isActionSelectable(focusedAction))"
          :action-editor="actionEditor"
          :action-delete="actionDelete"
          :manual-editor="manualEditor"
          :loop-editor="loopEditor"
          @open-action-insert="handleOpenActionInsert"
          @update-action-draft-type="actionDraftType = $event"
          @update-action-draft-selector="actionDraftSelector = $event"
          @update-action-draft-value="actionDraftValue = $event"
          @update-action-draft-checked="actionDraftChecked = $event"
          @submit-action-insert="handleSubmitActionInsert"
          @cancel-action-insert="handleCancelActionInsert"
          @request-action-delete="handleRequestActionDelete"
          @confirm-action-delete="handleConfirmActionDelete"
          @cancel-action-delete="handleCancelActionDelete"
          @update-action-included="handleActionIncluded"
          @update-action-selected="handleActionSelected"
          @update-manual-title="manualStepTitle = $event"
          @create-manual-step="handleCreateManualStep"
          @clear-manual-selection="clearActionSelection"
          @update-loop-start-action-id="loopStartActionId = $event"
          @update-loop-next-action-id="loopNextActionId = $event"
          @update-loop-entry-action-id="loopEntryActionId = $event"
          @update-loop-max-pages="loopMaxPages = $event"
          @update-loop-candidate-index="selectedLoopCandidateIndex = $event"
          @preview-loop="handlePreviewLoop"
          @create-loop="handleCreateLoop"
          @reconfigure-loop="handleDissolveLoop(true)"
          @dissolve-loop="handleDissolveLoop(false)"
        />
      </div>
    </template>

    <Teleport to="body">
      <div
        v-if="outputDrawerOpen && generatedScript"
        class="output-drawer-backdrop"
        @click.self="outputDrawerOpen = false"
      >
        <aside
          class="output-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="recording-output-title"
          data-cy="recording-output-drawer"
        >
          <header>
            <div>
              <span>脚本输出</span>
              <h4 id="recording-output-title">{{ generatedScript.filename }}</h4>
            </div>
            <button type="button" aria-label="关闭代码抽屉" @click="outputDrawerOpen = false">
              ×
            </button>
          </header>

          <div class="drawer-content">
            <div class="code-preview" data-cy="recording-code-preview">
              <div class="preview-header">
                <span>ES Module 代码</span>
                <code>{{ generatedScript.filename }}</code>
              </div>
              <pre><code>{{ generatedScript.code }}</code></pre>
            </div>

            <div v-if="errorMessage" class="drawer-error" role="alert">
              <div>
                <strong>操作未完成</strong>
                <p>{{ errorMessage }}</p>
              </div>
              <button type="button" aria-label="关闭抽屉错误提示" @click="clearError">×</button>
            </div>

            <div
              v-if="validationResult"
              class="validation-result"
              :class="validationResult.valid ? 'validation-success' : 'validation-error'"
              role="status"
            >
              <strong>{{ validationResult.valid ? "代码校验通过" : "代码校验未通过" }}</strong>
              <p v-if="validationResult.message">{{ validationResult.message }}</p>
              <ul v-if="validationResult.errors?.length">
                <li
                  v-for="item in validationResult.errors"
                  :key="`${item.line}:${item.character}:${item.message}`"
                >
                  第 {{ item.line }} 行:{{ item.character }} — {{ item.message }}
                </li>
              </ul>
            </div>

            <div
              v-if="savedScript"
              class="save-success"
              role="status"
              data-cy="recording-save-success"
            >
              已保存为 <code>{{ savedScript.filename }}</code>
            </div>
          </div>

          <footer>
            <button
              type="button"
              class="save-button"
              :disabled="!canValidateAndSave"
              data-cy="recording-validate-save"
              @click="handleValidateAndSave"
            >
              <template v-if="operation === 'validating'">正在校验…</template>
              <template v-else-if="operation === 'saving'">正在保存…</template>
              <template v-else>校验并保存</template>
            </button>
          </footer>
        </aside>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.recording-panel {
  overflow: hidden;
  color: #0f172a;
  background: #ffffff;
  border: 1px solid #dbe3ef;
  border-radius: 16px;
  box-shadow: var(--shadow-sm);
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 1.25rem 1.5rem;
  background:
    radial-gradient(circle at 88% 10%, rgba(129, 140, 248, 0.18), transparent 30%),
    linear-gradient(135deg, #f8fafc 0%, #eef2ff 100%);
  border-bottom: 1px solid #dbe3ef;
}

.header-copy {
  min-width: 0;
}

.eyebrow-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.65rem;
  margin-bottom: 0.45rem;
}

.eyebrow {
  color: #4f46e5;
  font-size: 0.7rem;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.header-copy h3 {
  margin: 0;
  overflow: hidden;
  color: #0f172a;
  font-size: 1.2rem;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-copy p {
  max-width: 760px;
  margin: 0.35rem 0 0;
  overflow: hidden;
  color: #64748b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.76rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-badge,
.stream-state {
  display: inline-flex;
  align-items: center;
  gap: 0.38rem;
  padding: 0.22rem 0.58rem;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
}

.status-dot {
  width: 6px;
  height: 6px;
  background: currentColor;
  border-radius: 50%;
}

.status-live {
  color: #b91c1c;
  background: #fef2f2;
  border-color: #fecaca;
}

.status-ready {
  color: #4338ca;
  background: #eef2ff;
  border-color: #c7d2fe;
}

.status-success {
  color: #047857;
  background: #ecfdf5;
  border-color: #a7f3d0;
}

.status-danger {
  color: #b91c1c;
  background: #fff1f2;
  border-color: #fecdd3;
}

.status-neutral {
  color: #475569;
  background: #f1f5f9;
  border-color: #e2e8f0;
}

.close-button,
.message-banner button {
  display: grid;
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  padding: 0;
  color: #64748b;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid #dbe3ef;
  border-radius: 9px;
  place-items: center;
  font-size: 1.25rem;
}

.close-button:hover:not(:disabled),
.message-banner button:hover {
  color: #0f172a;
  background: #ffffff;
  border-color: #94a3b8;
}

.close-button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.message-banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin: 1rem 1.5rem 0;
  padding: 0.85rem 1rem;
  border: 1px solid;
  border-radius: 10px;
}

.message-banner strong,
.message-banner p {
  margin: 0;
}

.message-banner p {
  margin-top: 0.2rem;
  font-size: 0.82rem;
  line-height: 1.45;
}

.error-banner {
  color: #991b1b;
  background: #fff7f7;
  border-color: #fecaca;
}

.error-banner button {
  width: 26px;
  height: 26px;
  color: #991b1b;
  background: transparent;
  border: 0;
}

.empty-state {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.5rem;
}

.empty-mark {
  display: grid;
  flex: 0 0 auto;
  width: 46px;
  height: 46px;
  background: #eef2ff;
  border: 1px solid #c7d2fe;
  border-radius: 13px;
  place-items: center;
}

.empty-mark span {
  width: 17px;
  height: 17px;
  border: 3px solid #4f46e5;
  border-radius: 50%;
  box-shadow: 0 0 0 4px rgba(79, 70, 229, 0.12);
}

.empty-copy {
  flex: 1;
  min-width: 0;
}

.empty-copy h4,
.empty-copy p {
  margin: 0;
}

.empty-copy h4 {
  font-size: 0.95rem;
}

.empty-copy p {
  margin-top: 0.3rem;
  color: #64748b;
  font-size: 0.82rem;
  line-height: 1.5;
}

.primary-button,
.stop-button,
.save-button,
.secondary-toolbar-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 38px;
  padding: 0.55rem 0.9rem;
  cursor: pointer;
  border-radius: 8px;
  font-size: 0.8rem;
  font-weight: 750;
  transition: 0.18s ease;
}

.primary-button {
  color: #ffffff;
  background: linear-gradient(135deg, #4f46e5, #6366f1);
  border: 1px solid #4f46e5;
  box-shadow: 0 3px 8px rgba(79, 70, 229, 0.2);
}

.primary-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 5px 12px rgba(79, 70, 229, 0.28);
}

.primary-button:disabled,
.stop-button:disabled,
.save-button:disabled,
.secondary-toolbar-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
  box-shadow: none;
  transform: none;
}

.inline-loader {
  color: #4f46e5;
  font-size: 0.8rem;
  font-weight: 700;
  white-space: nowrap;
}

.session-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1.5rem;
  border-bottom: 1px solid #edf1f7;
}

.session-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem;
  min-width: 0;
}

.live-state {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}

.live-state > div {
  display: flex;
  flex-direction: column;
  gap: 0.12rem;
}

.live-state strong {
  font-size: 0.86rem;
}

.live-state span:not(.live-indicator) {
  color: #64748b;
  font-size: 0.74rem;
}

.live-indicator {
  position: relative;
  width: 10px;
  height: 10px;
  background: #94a3b8;
  border-radius: 50%;
}

.live-indicator.pulsing {
  background: #ef4444;
}

.live-indicator.pulsing::after {
  position: absolute;
  inset: -4px;
  border: 1px solid rgba(239, 68, 68, 0.48);
  border-radius: 50%;
  content: "";
  animation: recording-pulse 1.6s ease-out infinite;
}

@keyframes recording-pulse {
  0% {
    opacity: 0.85;
    transform: scale(0.7);
  }
  100% {
    opacity: 0;
    transform: scale(1.35);
  }
}

.stream-state {
  color: #64748b;
  background: #f8fafc;
  border-color: #e2e8f0;
}

.stream-state.connected {
  color: #047857;
  background: #ecfdf5;
  border-color: #a7f3d0;
}

.stream-state.warning {
  color: #b45309;
  background: #fffbeb;
  border-color: #fde68a;
}

.session-actions {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  flex: 1 1 540px;
  gap: 0.45rem;
  min-width: 0;
}

.toolbar-filename {
  display: grid;
  flex: 1 1 220px;
  gap: 0.22rem;
  max-width: 280px;
  min-width: 150px;
}

.toolbar-filename > span {
  color: #64748b;
  font-size: 0.61rem;
  font-weight: 700;
}

.toolbar-filename input {
  box-sizing: border-box;
  width: 100%;
  height: 36px;
  min-width: 0;
  padding: 0 0.65rem;
  color: #1e293b;
  background: #ffffff;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  outline: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.7rem;
}

.toolbar-filename input:focus {
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.12);
}

.toolbar-filename input:disabled {
  color: #94a3b8;
  background: #f8fafc;
}

.toolbar-button {
  min-height: 36px;
  padding: 0.46rem 0.68rem;
  white-space: nowrap;
  font-size: 0.72rem;
}

.secondary-toolbar-button {
  color: #4338ca;
  background: #ffffff;
  border: 1px solid #c7d2fe;
}

.stop-button {
  flex: 0 0 auto;
  color: #b91c1c;
  background: #fff1f2;
  border: 1px solid #fecdd3;
}

.stop-button:hover:not(:disabled) {
  color: #ffffff;
  background: #dc2626;
  border-color: #dc2626;
}

.stream-warning {
  margin: 0;
  padding: 0.55rem 1.5rem;
  color: #92400e;
  background: #fffbeb;
  border-bottom: 1px solid #fde68a;
  font-size: 0.76rem;
}

.visual-workspace {
  display: grid;
  grid-template-columns: minmax(300px, 0.82fr) minmax(430px, 1.38fr) minmax(280px, 0.72fr);
  gap: 0.9rem;
  padding: 1rem 1.5rem;
  background: #f8fafc;
}

.output-drawer-backdrop {
  position: fixed;
  z-index: 1200;
  display: flex;
  inset: 0;
  justify-content: flex-end;
  background: rgba(15, 23, 42, 0.42);
  backdrop-filter: blur(2px);
}

.output-drawer {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(720px, 92vw);
  height: 100%;
  color: #0f172a;
  background: #ffffff;
  border-left: 1px solid #cbd5e1;
  box-shadow: -16px 0 40px rgba(15, 23, 42, 0.18);
}

.output-drawer > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 1rem 1.15rem;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
}

.output-drawer > header span {
  color: #4f46e5;
  font-size: 0.64rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.output-drawer > header h4 {
  margin: 0.18rem 0 0;
  font-size: 0.92rem;
}

.output-drawer > header button {
  display: grid;
  width: 32px;
  height: 32px;
  padding: 0;
  color: #64748b;
  cursor: pointer;
  background: #ffffff;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  place-items: center;
  font-size: 1.15rem;
}

.drawer-content {
  min-height: 0;
  padding: 1rem 1.15rem;
  overflow: auto;
}

.code-preview {
  overflow: hidden;
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 9px;
}

.preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.55rem 0.75rem;
  color: #94a3b8;
  background: #172033;
  border-bottom: 1px solid #263248;
  font-size: 0.68rem;
  font-weight: 700;
}

.preview-header code {
  overflow: hidden;
  color: #c7d2fe;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.code-preview pre {
  min-height: 360px;
  max-height: calc(100vh - 300px);
  margin: 0;
  padding: 0.9rem;
  overflow: auto;
  color: #dbeafe;
  font-size: 0.7rem;
  line-height: 1.6;
  tab-size: 2;
  white-space: pre;
}

.drawer-error {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-top: 0.8rem;
  padding: 0.72rem 0.8rem;
  color: #991b1b;
  background: #fff7f7;
  border: 1px solid #fecaca;
  border-radius: 8px;
  font-size: 0.72rem;
  line-height: 1.5;
}

.drawer-error p {
  margin: 0.2rem 0 0;
}

.drawer-error button {
  flex: 0 0 auto;
  padding: 0;
  color: #991b1b;
  cursor: pointer;
  background: transparent;
  border: 0;
  font-size: 1rem;
}

.validation-result,
.save-success {
  margin-top: 0.8rem;
  padding: 0.72rem 0.8rem;
  border: 1px solid;
  border-radius: 8px;
  font-size: 0.72rem;
  line-height: 1.5;
}

.validation-result p,
.validation-result ul {
  margin: 0.25rem 0 0;
}

.validation-result ul {
  max-height: 120px;
  padding-left: 1.1rem;
  overflow: auto;
}

.validation-success,
.save-success {
  color: #047857;
  background: #ecfdf5;
  border-color: #a7f3d0;
}

.validation-error {
  color: #b91c1c;
  background: #fff1f2;
  border-color: #fecdd3;
}

.save-success code {
  color: inherit;
  font-weight: 800;
}

.output-drawer > footer {
  padding: 0.9rem 1.15rem;
  background: #f8fafc;
  border-top: 1px solid #e2e8f0;
}

.save-button {
  width: 100%;
  color: #ffffff;
  background: linear-gradient(135deg, #059669, #0d9488);
  border: 1px solid #059669;
  box-shadow: 0 3px 8px rgba(5, 150, 105, 0.18);
}

.save-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 5px 12px rgba(5, 150, 105, 0.26);
}

@media (max-width: 1280px) {
  .session-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .session-actions {
    justify-content: flex-start;
    flex-basis: auto;
  }

  .visual-workspace {
    grid-template-columns: minmax(300px, 0.85fr) minmax(420px, 1.15fr);
  }

  .visual-workspace > :last-child {
    grid-column: 1 / -1;
  }
}

@media (max-width: 960px) {
  .visual-workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .visual-workspace > :last-child {
    grid-column: auto;
  }
}

@media (max-width: 640px) {
  .panel-header,
  .session-toolbar,
  .empty-state {
    padding-right: 1rem;
    padding-left: 1rem;
  }

  .panel-header {
    align-items: flex-start;
  }

  .message-banner {
    margin-right: 1rem;
    margin-left: 1rem;
  }

  .empty-state {
    align-items: stretch;
    flex-direction: column;
  }

  .empty-mark {
    display: none;
  }

  .session-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .toolbar-filename {
    max-width: none;
  }

  .toolbar-button {
    width: 100%;
  }

  .visual-workspace {
    padding-right: 1rem;
    padding-left: 1rem;
  }

  .output-drawer {
    width: 100vw;
  }
}
</style>
