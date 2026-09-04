<script setup lang="ts">
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import {
  Handle,
  Position,
  useVueFlow,
  VueFlow,
  type Edge,
  type Node,
  type NodeDragEvent,
  type NodeMouseEvent,
} from "@vue-flow/core";
import { nextTick, ref, watch } from "vue";
import type { RecordedAction, RecordedPage, RecordedPaginationLoop } from "../../types/automation";

interface FlowNodeData {
  kind: "start" | "action" | "manual" | "loop";
  title: string;
  subtitle: string;
  pageId?: string;
  actionId?: string;
  included: boolean;
  selected: boolean;
  selectable: boolean;
  pending: boolean;
  loopMember: boolean;
}

interface RootExecutionUnit {
  id: string;
  included: boolean;
}

const props = defineProps<{
  pages: readonly RecordedPage[];
  actions: readonly RecordedAction[];
  paginationLoop?: RecordedPaginationLoop;
  focusedNodeId: string | null;
  recording: boolean;
  selectedActionIds: readonly string[];
  selectableActionIds: readonly string[];
  pendingActionIds: readonly string[];
  canUpdateActions: boolean;
  canMutateActions: boolean;
}>();

const emit = defineEmits<{
  "focus-node": [nodeId: string];
  "insert-after": [actionId: string | null];
  "update-action-included": [actionId: string, included: boolean];
  "update-action-selected": [actionId: string, selected: boolean];
}>();

const ACTION_LABELS: Record<RecordedAction["type"], string> = {
  click: "点击",
  fill: "输入",
  select: "选择",
  setChecked: "勾选",
  press: "按键",
  scroll: "滚动",
  closePage: "关闭页面",
  manualStep: "人工步骤",
};

const ACTION_NODE_WIDTH = 180;
const LOOP_NODE_WIDTH = 232;
const LOOP_CHILD_TOP = 68;
const LOOP_CHILD_GAP = 112;
const ROOT_NODE_GAP = 122;

const nodes = ref<Node<FlowNodeData>[]>([]);
const edges = ref<Edge[]>([]);
const savedPositions = new Map<string, { x: number; y: number }>();
const { fitView } = useVueFlow();
let fittedTopology = "";

const fitGraph = async (): Promise<void> => {
  await nextTick();
  await fitView({ padding: 0.18, duration: 180, maxZoom: 1 });
};

const compactText = (value: unknown): string => {
  if (Array.isArray(value)) return value.join(", ").slice(0, 54);
  if (value === undefined) return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, 54);
};

const actionSubtitle = (action: RecordedAction): string => {
  if (action.type === "manualStep") {
    const names = (action.targets ?? []).map((target) => target.displayName).filter(Boolean);
    return names.join("、").slice(0, 54) || "等待真实用户完成";
  }
  if (action.selector) return action.selector.slice(0, 54);
  return compactText(action.value) || action.pageId;
};

const positionKey = (nodeId: string, parentNode?: string): string =>
  `${parentNode ?? "root"}:${nodeId}`;

const savedPosition = (
  nodeId: string,
  fallback: { x: number; y: number },
  parentNode?: string,
): { x: number; y: number } => savedPositions.get(positionKey(nodeId, parentNode)) ?? fallback;

const resolveLoopActions = (ordered: RecordedAction[]): RecordedAction[] | null => {
  const loop = props.paginationLoop;
  if (!loop || loop.actionIds.length === 0) return null;

  const loopIds = new Set(loop.actionIds);
  if (loopIds.size !== loop.actionIds.length) return null;
  const actionById = new Map(ordered.map((action) => [action.id, action]));
  const members = loop.actionIds.map((actionId) => actionById.get(actionId));
  if (members.some((action) => action === undefined)) return null;
  return (members as RecordedAction[]).sort((left, right) => left.order - right.order);
};

const actionNode = (
  action: RecordedAction,
  position: { x: number; y: number },
  selectedIds: ReadonlySet<string>,
  selectableIds: ReadonlySet<string>,
  pendingIds: ReadonlySet<string>,
  parentNode?: string,
): Node<FlowNodeData> => {
  const pending = pendingIds.has(action.id);
  const loopMember = parentNode === "pagination-loop";
  const data: FlowNodeData = {
    kind: action.type === "manualStep" ? "manual" : "action",
    title: `${action.order}. ${ACTION_LABELS[action.type]}`,
    subtitle: actionSubtitle(action),
    pageId: action.pageId,
    actionId: action.id,
    included: action.included,
    selected: selectedIds.has(action.id),
    selectable: selectableIds.has(action.id),
    pending,
    loopMember,
  };

  return {
    id: action.id,
    type: "recording",
    position: savedPosition(action.id, position, parentNode),
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    draggable: true,
    connectable: false,
    deletable: false,
    width: ACTION_NODE_WIDTH,
    parentNode,
    extent: parentNode ? ("parent" as const) : undefined,
    zIndex: parentNode ? 1 : 0,
    class: [
      `node-${data.kind}`,
      props.focusedNodeId === action.id ? "node-focused" : "",
      action.included ? "" : "node-excluded",
      data.selected ? "node-range-selected" : "",
    ],
    data,
    ariaLabel: `${data.title}，${data.subtitle}`,
    domAttributes: {
      "data-cy": "recording-action-node",
      "data-node-id": action.id,
      "data-action-id": action.id,
      "data-page-id": action.pageId,
      ...(parentNode ? { "data-parent-node": parentNode } : {}),
    },
  } satisfies Node<FlowNodeData>;
};

const rebuildGraph = (resetPositions = false): void => {
  if (resetPositions) savedPositions.clear();

  const ordered = [...props.actions].sort((left, right) => left.order - right.order);
  const loopActions = resolveLoopActions(ordered);
  const loopIds = new Set(loopActions?.map((action) => action.id) ?? []);
  const selectedIds = new Set(props.selectedActionIds);
  const selectableIds = new Set(props.selectableActionIds);
  const pendingIds = new Set(props.pendingActionIds);
  const pageColumns = new Map(props.pages.map((page, index) => [page.id, index]));
  const nextNodes: Node<FlowNodeData>[] = [];
  const rootUnits: RootExecutionUnit[] = [];

  const startData: FlowNodeData = {
    kind: "start",
    title: "Start",
    subtitle: props.pages[0]?.url ?? "等待 page0",
    pageId: "page0",
    included: true,
    selected: false,
    selectable: false,
    pending: false,
    loopMember: false,
  };
  nextNodes.push({
    id: "recording-start",
    type: "recording",
    position: savedPosition("recording-start", { x: 28, y: 28 }),
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    draggable: true,
    connectable: false,
    deletable: false,
    width: ACTION_NODE_WIDTH,
    class: ["node-start", props.focusedNodeId === "recording-start" ? "node-focused" : ""],
    data: startData,
    ariaLabel: `${startData.title}，${startData.subtitle}`,
    domAttributes: {
      "data-cy": "recording-start-node",
      "data-node-id": "recording-start",
      "data-page-id": "page0",
    },
  } satisfies Node<FlowNodeData>);
  rootUnits.push({ id: "recording-start", included: true });

  let rootY = 28 + ROOT_NODE_GAP;
  let loopInserted = false;
  for (const action of ordered) {
    if (loopActions && loopIds.has(action.id)) {
      if (loopInserted) continue;
      loopInserted = true;

      const loop = props.paginationLoop;
      const firstAction = loopActions[0];
      const lastAction = loopActions.at(-1);
      const loopHeight = LOOP_CHILD_TOP + loopActions.length * LOOP_CHILD_GAP + 20;
      const pageColumn = pageColumns.get(firstAction?.pageId ?? "page0") ?? 0;
      const loopData: FlowNodeData = {
        kind: "loop",
        title: "分页列表循环",
        subtitle: `步骤 ${firstAction?.order}–${lastAction?.order} · 最多 ${loop?.maxPages ?? 0} 页`,
        pageId: firstAction?.pageId,
        included: true,
        selected: false,
        selectable: false,
        pending: false,
        loopMember: false,
      };
      nextNodes.push({
        id: "pagination-loop",
        type: "recording",
        position: savedPosition("pagination-loop", {
          x: 28 + pageColumn * 210,
          y: rootY,
        }),
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        draggable: true,
        connectable: false,
        deletable: false,
        width: LOOP_NODE_WIDTH,
        height: loopHeight,
        zIndex: 0,
        class: ["node-loop", props.focusedNodeId === "pagination-loop" ? "node-focused" : ""],
        data: loopData,
        ariaLabel: `${loopData.title}，${loopData.subtitle}`,
        domAttributes: {
          "data-cy": "recording-pagination-node",
          "data-node-id": "pagination-loop",
          ...(firstAction?.pageId ? { "data-page-id": firstAction.pageId } : {}),
        },
      } satisfies Node<FlowNodeData>);
      rootUnits.push({ id: "pagination-loop", included: true });

      for (const [index, loopAction] of loopActions.entries()) {
        nextNodes.push(
          actionNode(
            loopAction,
            { x: 24, y: LOOP_CHILD_TOP + index * LOOP_CHILD_GAP },
            selectedIds,
            selectableIds,
            pendingIds,
            "pagination-loop",
          ),
        );
      }
      rootY += loopHeight + 42;
      continue;
    }

    const pageColumn = pageColumns.get(action.pageId) ?? 0;
    nextNodes.push(
      actionNode(
        action,
        { x: 28 + pageColumn * 210, y: rootY },
        selectedIds,
        selectableIds,
        pendingIds,
      ),
    );
    rootUnits.push({ id: action.id, included: action.included });
    rootY += ROOT_NODE_GAP;
  }

  nodes.value = nextNodes;

  const rootEdges: Edge[] = rootUnits.slice(1).map((unit, index) => ({
    id: `edge:root:${rootUnits[index]?.id}:${unit.id}`,
    source: rootUnits[index]?.id ?? "recording-start",
    target: unit.id,
    type: "smoothstep",
    animated: props.recording && index === rootUnits.length - 2,
    selectable: false,
    focusable: false,
    style: { stroke: unit.included ? "#94a3b8" : "#cbd5e1", strokeWidth: 1.6 },
  }));
  const loopEdges: Edge[] = (loopActions ?? []).slice(1).map((action, index) => ({
    id: `edge:pagination-loop:${loopActions?.[index]?.id}:${action.id}`,
    source: loopActions?.[index]?.id ?? action.id,
    target: action.id,
    type: "smoothstep",
    selectable: false,
    focusable: false,
    style: { stroke: "#8b5cf6", strokeWidth: 1.5 },
  }));
  edges.value = [...rootEdges, ...loopEdges];
};

const handleNodeClick = ({ node }: NodeMouseEvent): void => {
  emit("focus-node", node.id);
};

const handleNodeDragStop = ({ node }: NodeDragEvent): void => {
  savedPositions.set(positionKey(node.id, node.parentNode), { ...node.position });
};

const handleIncludedChange = (actionId: string, event: Event): void => {
  emit("update-action-included", actionId, (event.target as HTMLInputElement).checked);
};

const handleSelectedChange = (actionId: string, event: Event): void => {
  emit("update-action-selected", actionId, (event.target as HTMLInputElement).checked);
};

const handleInsertAfter = (actionId?: string): void => {
  emit("insert-after", actionId ?? null);
};

const graphTopology = (): string =>
  [
    props.pages.map((page) => page.id).join(","),
    props.actions.map((action) => `${action.id}:${action.pageId}`).join(","),
    props.paginationLoop?.actionIds.join(",") ?? "no-loop",
  ].join("|");

const restoreAutoLayout = (): void => {
  rebuildGraph(true);
  void fitGraph();
};

watch(
  () => [
    props.pages,
    props.actions,
    props.paginationLoop,
    props.focusedNodeId,
    props.recording,
    props.selectedActionIds,
    props.selectableActionIds,
    props.pendingActionIds,
    props.canUpdateActions,
  ],
  () => {
    const topology = graphTopology();
    const shouldFit = topology !== fittedTopology;
    fittedTopology = topology;
    rebuildGraph();
    if (shouldFit) void fitGraph();
  },
  { deep: true, immediate: true },
);
</script>

<template>
  <section class="flow-card" aria-labelledby="recording-flow-title" data-cy="recording-flow">
    <header class="flow-header">
      <div>
        <span>Vue Flow</span>
        <h4 id="recording-flow-title">执行流程</h4>
      </div>
      <button type="button" title="恢复自动布局" @click="restoreAutoLayout">自动布局</button>
    </header>

    <div class="flow-canvas">
      <VueFlow
        v-model:nodes="nodes"
        v-model:edges="edges"
        :fit-view-on-init="true"
        :min-zoom="0.25"
        :max-zoom="1.8"
        :nodes-connectable="false"
        :delete-key-code="null"
        :multi-selection-key-code="null"
        class="recording-vue-flow"
        @node-click="handleNodeClick"
        @node-drag-stop="handleNodeDragStop"
      >
        <template #node-recording="{ data, id }">
          <div
            class="flow-node"
            :class="[
              `flow-node-${data.kind}`,
              {
                focused: props.focusedNodeId === id,
                excluded: !data.included,
                selected: data.selected,
              },
            ]"
          >
            <Handle type="target" :position="Position.Top" />
            <span class="flow-node-kind">{{ data.pageId || "flow" }}</span>
            <strong>{{ data.title }}</strong>
            <small>{{ data.subtitle }}</small>

            <div
              v-if="data.actionId"
              class="flow-node-controls nodrag nopan"
              @pointerdown.stop
              @click.stop
              @keydown.stop
            >
              <label>
                <input
                  type="checkbox"
                  :checked="data.included"
                  :disabled="!props.canUpdateActions || data.pending || data.loopMember"
                  data-cy="recording-flow-include-toggle"
                  :aria-label="`${data.included ? '排除' : '包含'}${data.title}`"
                  @change="handleIncludedChange(data.actionId, $event)"
                />
                <span>{{ data.pending ? "同步中" : "包含" }}</span>
              </label>
              <label>
                <input
                  type="checkbox"
                  :checked="data.selected"
                  :disabled="!data.selectable"
                  data-cy="recording-flow-manual-select"
                  :aria-label="`选择${data.title}加入人工步骤`"
                  @change="handleSelectedChange(data.actionId, $event)"
                />
                <span>人工范围</span>
              </label>
            </div>
            <button
              v-if="data.kind !== 'loop' && !data.loopMember"
              type="button"
              class="flow-node-insert nodrag nopan"
              :disabled="!props.canMutateActions"
              :data-anchor-action-id="data.actionId ?? 'recording-start'"
              data-cy="recording-action-insert-after"
              title="停止录制后可在此节点后新增动作"
              @pointerdown.stop
              @click.stop="handleInsertAfter(data.actionId)"
            >
              <span aria-hidden="true">＋</span>
              在后面添加
            </button>
            <Handle type="source" :position="Position.Bottom" />
          </div>
        </template>
      </VueFlow>

      <div v-if="props.actions.length === 0" class="flow-empty">
        在真实 Chrome 页面操作后，节点会实时加入流程图。
      </div>
    </div>
    <footer>拖动只保存布局；节点启用、人工范围和分页循环均在当前流程界面编排。</footer>
  </section>
</template>

<style scoped>
.flow-card {
  min-width: 0;
  overflow: hidden;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
}

.flow-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 62px;
  padding: 0.8rem 0.9rem;
  border-bottom: 1px solid #eef2f7;
}

.flow-header span {
  color: #4f46e5;
  font-size: 0.65rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.flow-header h4 {
  margin: 0.15rem 0 0;
  color: #1e293b;
  font-size: 0.9rem;
}

.flow-header button {
  padding: 0.4rem 0.6rem;
  color: #475569;
  background: #ffffff;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  cursor: pointer;
  font-size: 0.68rem;
  font-weight: 700;
}

.flow-canvas {
  position: relative;
  height: 560px;
  background-color: #f8fafc;
  background-image: radial-gradient(#cbd5e1 0.8px, transparent 0.8px);
  background-size: 16px 16px;
}

.recording-vue-flow {
  background: transparent;
}

.flow-node {
  position: relative;
  display: grid;
  box-sizing: border-box;
  width: 100%;
  gap: 0.2rem;
  padding: 0.65rem 0.72rem;
  color: #1e293b;
  background: #ffffff;
  border: 1px solid #cbd5e1;
  border-radius: 9px;
  box-shadow: 0 4px 12px rgba(15, 23, 42, 0.07);
}

.flow-node.focused {
  border-color: #4f46e5;
  box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.14);
}

.flow-node.selected {
  border-color: #f59e0b;
  box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.14);
}

.flow-node-excluded,
.flow-node.excluded {
  opacity: 0.48;
}

.flow-node-start {
  color: #166534;
  background: #f0fdf4;
  border-color: #86efac;
}

.flow-node-manual {
  color: #92400e;
  background: #fffbeb;
  border-color: #fcd34d;
}

.flow-node-loop {
  align-content: start;
  height: 100%;
  color: #5b21b6;
  background: rgba(245, 243, 255, 0.72);
  border: 2px dashed #8b5cf6;
  box-shadow: 0 6px 18px rgba(91, 33, 182, 0.08);
}

.flow-node-kind {
  color: #64748b;
  font-size: 0.57rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.flow-node strong {
  overflow: hidden;
  font-size: 0.75rem;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flow-node small {
  display: block;
  overflow: hidden;
  color: #64748b;
  font-family: var(--font-mono);
  font-size: 0.58rem;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.flow-node-controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.3rem;
  margin-top: 0.28rem;
  padding-top: 0.38rem;
  border-top: 1px solid rgba(148, 163, 184, 0.28);
}

.flow-node-controls label {
  display: flex;
  align-items: center;
  gap: 0.22rem;
  min-width: 0;
  color: #64748b;
  cursor: pointer;
  font-size: 0.55rem;
  font-weight: 700;
  white-space: nowrap;
}

.flow-node-controls label:has(input:disabled) {
  cursor: not-allowed;
  opacity: 0.5;
}

.flow-node-controls input {
  width: 12px;
  height: 12px;
  margin: 0;
  accent-color: #4f46e5;
}

.flow-node-controls label:last-child input {
  accent-color: #d97706;
}

.flow-node-insert {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.2rem;
  width: 100%;
  min-height: 24px;
  margin-top: 0.3rem;
  padding: 0.18rem 0.35rem;
  color: #4338ca;
  cursor: pointer;
  background: #eef2ff;
  border: 1px dashed #a5b4fc;
  border-radius: 6px;
  font-size: 0.56rem;
  font-weight: 750;
}

.flow-node-insert:hover:not(:disabled) {
  color: #ffffff;
  background: #4f46e5;
  border-style: solid;
}

.flow-node-insert:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.flow-empty {
  position: absolute;
  right: 1rem;
  bottom: 1rem;
  left: 1rem;
  padding: 0.7rem;
  color: #64748b;
  background: rgba(255, 255, 255, 0.9);
  border: 1px dashed #cbd5e1;
  border-radius: 8px;
  font-size: 0.68rem;
  text-align: center;
  pointer-events: none;
}

.flow-card footer {
  padding: 0.65rem 0.8rem;
  color: #64748b;
  background: #f8fafc;
  border-top: 1px solid #eef2f7;
  font-size: 0.64rem;
  line-height: 1.5;
}

:deep(.vue-flow__handle) {
  width: 7px;
  height: 7px;
  background: #64748b;
  border: 1px solid #ffffff;
}

:deep(.vue-flow__node-recording) {
  padding: 0;
  background: transparent;
  border: 0;
}

:deep(.vue-flow__node-recording:focus) {
  outline: none;
}
</style>
