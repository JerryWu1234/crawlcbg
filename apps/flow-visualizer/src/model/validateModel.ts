import type { FlowModel, FlowTransition } from "../types/flow";

const epsilon = 0.000_001;

function requireText(value: string, context: string, errors: string[]) {
  if (!value.trim()) errors.push(`${context} 不能为空`);
}

function requireUnique(values: string[], context: string, errors: string[]) {
  if (new Set(values).size !== values.length) errors.push(`${context} 必须唯一`);
}

function validatePrimaryPath(
  flowId: string,
  transitions: FlowTransition[],
  firstStageId: string | undefined,
  lastStageId: string | undefined,
  errors: string[],
) {
  if (transitions.length === 0) return;

  if (transitions[0]?.from !== firstStageId) {
    errors.push(`flow ${flowId} 主路径必须从第一个 primary stage 开始`);
  }
  if (transitions.at(-1)?.to !== lastStageId) {
    errors.push(`flow ${flowId} 主路径必须在最后一个 primary stage 结束`);
  }

  let coverageEnd = transitions[0]?.window[1] ?? 0;
  if ((transitions[0]?.window[0] ?? 1) > epsilon) {
    errors.push(`flow ${flowId} 主路径必须从 progress 0 开始覆盖`);
  }

  transitions.forEach((transition, index) => {
    const previous = transitions[index - 1];
    if (previous && transition.window[0] + epsilon < previous.window[0]) {
      errors.push(`flow ${flowId} primary transition 必须按 window 起点排序`);
    }
    if (previous && previous.to !== transition.from) {
      errors.push(`flow ${flowId} primary transition ${previous.id} → ${transition.id} 不连通`);
    }
    if (transition.window[0] > coverageEnd + epsilon) {
      errors.push(`flow ${flowId} 主路径在 ${coverageEnd}–${transition.window[0]} 存在空窗`);
    }
    coverageEnd = Math.max(coverageEnd, transition.window[1]);
  });

  if (coverageEnd < 1 - epsilon) {
    errors.push(`flow ${flowId} 主路径必须覆盖到 progress 1`);
  }
}

export function validateFlowModel(model: FlowModel): FlowModel {
  const errors: string[] = [];
  const sourceIds = new Set(model.sources.map((source) => source.id));
  const dataIds = new Set(model.dataDetails.map((detail) => detail.id));
  const participantIds = new Set(model.participants.map((participant) => participant.id));
  const globalStageIds = new Set<string>();
  const globalTransitionIds = new Set<string>();
  const flowIds = new Set<string>();

  if (model.sources.length === 0) errors.push("model 至少需要一个 source");
  if (model.dataDetails.length === 0) errors.push("model 至少需要一个 data detail");
  if (model.participants.length === 0) errors.push("model 至少需要一个 participant");
  if (model.flows.length === 0) errors.push("model 至少需要一个 flow");

  requireUnique(
    model.sources.map((source) => source.id),
    "source id",
    errors,
  );
  requireUnique(
    model.dataDetails.map((detail) => detail.id),
    "data detail id",
    errors,
  );
  requireUnique(
    model.participants.map((participant) => participant.id),
    "participant id",
    errors,
  );
  requireUnique(
    model.connections.map((connection) => connection.id),
    "connection id",
    errors,
  );

  for (const source of model.sources) {
    requireText(source.id, "source.id", errors);
    requireText(source.path, `source ${source.id}.path`, errors);
    requireText(source.symbol, `source ${source.id}.symbol`, errors);
    requireText(source.claim, `source ${source.id}.claim`, errors);
  }

  for (const participant of model.participants) {
    requireText(participant.label, `participant ${participant.id}.label`, errors);
    requireText(participant.detail, `participant ${participant.id}.detail`, errors);
    if (participant.sourceIds.length === 0) {
      errors.push(`participant ${participant.id} 缺少 source`);
    }
    for (const sourceId of participant.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        errors.push(`participant ${participant.id} 引用了未知 source ${sourceId}`);
      }
    }
  }

  for (const connection of model.connections) {
    requireText(connection.label, `connection ${connection.id}.label`, errors);
    requireText(connection.protocol, `connection ${connection.id}.protocol`, errors);
    if (!participantIds.has(connection.from) || !participantIds.has(connection.to)) {
      errors.push(`connection ${connection.id} 引用了未知 participant`);
    }
  }

  for (const detail of model.dataDetails) {
    requireText(detail.purpose, `data ${detail.id}.purpose`, errors);
    requireText(detail.lifecycle, `data ${detail.id}.lifecycle`, errors);
    if (detail.fields.length === 0) errors.push(`data ${detail.id} 至少需要一个字段`);
    if (detail.sourceIds.length === 0) errors.push(`data ${detail.id} 缺少 source`);
    for (const field of detail.fields) {
      requireText(field.path, `data ${detail.id}.field.path`, errors);
      requireText(field.type, `data ${detail.id}.${field.path}.type`, errors);
      requireText(field.example, `data ${detail.id}.${field.path}.example`, errors);
      requireText(field.purpose, `data ${detail.id}.${field.path}.purpose`, errors);
    }
    for (const sourceId of detail.sourceIds) {
      if (!sourceIds.has(sourceId)) errors.push(`data ${detail.id} 引用了未知 source ${sourceId}`);
    }
  }

  for (const flow of model.flows) {
    if (flowIds.has(flow.id)) errors.push(`flow id ${flow.id} 重复`);
    flowIds.add(flow.id);
    requireText(flow.id, "flow.id", errors);
    requireText(flow.summary, `flow ${flow.id}.summary`, errors);
    requireText(flow.outcome, `flow ${flow.id}.outcome`, errors);
    if (flow.stages.length === 0) errors.push(`flow ${flow.id} 至少需要一个 stage`);
    if (flow.transitions.length === 0) errors.push(`flow ${flow.id} 至少需要一个 transition`);
    if (flow.primaryStageIds.length === 0) errors.push(`flow ${flow.id} 缺少 primary stage`);
    if (flow.primaryTransitionIds.length === 0) {
      errors.push(`flow ${flow.id} 缺少 primary transition`);
    }

    const stageIds = new Set(flow.stages.map((stage) => stage.id));
    const transitionIds = new Set(flow.transitions.map((transition) => transition.id));
    requireUnique(
      flow.stages.map((stage) => stage.id),
      `flow ${flow.id} stage id`,
      errors,
    );
    requireUnique(
      flow.transitions.map((transition) => transition.id),
      `flow ${flow.id} transition id`,
      errors,
    );
    requireUnique(flow.primaryStageIds, `flow ${flow.id} primary stage id`, errors);
    requireUnique(flow.primaryTransitionIds, `flow ${flow.id} primary transition id`, errors);

    for (const stage of flow.stages) {
      if (globalStageIds.has(stage.id)) errors.push(`stage id ${stage.id} 必须全局唯一`);
      globalStageIds.add(stage.id);
      if (!Number.isFinite(stage.progress) || stage.progress < 0 || stage.progress > 1) {
        errors.push(`stage ${stage.id}.progress 必须是 0..1 的有限数`);
      }
      requireText(stage.explanation, `stage ${stage.id}.explanation`, errors);
      if (stage.participants.length === 0) errors.push(`stage ${stage.id} 缺少 participant`);
      if (stage.sourceIds.length === 0) errors.push(`stage ${stage.id} 缺少 source`);
      for (const sourceId of stage.sourceIds) {
        if (!sourceIds.has(sourceId)) {
          errors.push(`stage ${stage.id} 引用了未知 source ${sourceId}`);
        }
      }
    }

    for (const transition of flow.transitions) {
      if (globalTransitionIds.has(transition.id)) {
        errors.push(`transition id ${transition.id} 必须全局唯一`);
      }
      globalTransitionIds.add(transition.id);
      if (!stageIds.has(transition.from) || !stageIds.has(transition.to)) {
        errors.push(`transition ${transition.id} 的 stage 关联无效`);
      }
      if (!dataIds.has(transition.dataDetailId)) {
        errors.push(`transition ${transition.id} 缺少有效 data detail`);
      }
      const [start, end] = transition.window;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > 1) {
        errors.push(`transition ${transition.id}.window 必须包含 0..1 的有限数`);
      }
      if (start > end) errors.push(`transition ${transition.id}.window 起点不能晚于终点`);
      requireText(transition.explanation, `transition ${transition.id}.explanation`, errors);
      requireText(transition.payloadExample, `transition ${transition.id}.payloadExample`, errors);
      if (transition.sourceIds.length === 0) errors.push(`transition ${transition.id} 缺少 source`);
      for (const sourceId of transition.sourceIds) {
        if (!sourceIds.has(sourceId)) {
          errors.push(`transition ${transition.id} 引用了未知 source ${sourceId}`);
        }
      }
    }

    const primaryStages = flow.primaryStageIds
      .map((stageId) => {
        if (!stageIds.has(stageId)) errors.push(`flow ${flow.id} primary stage ${stageId} 无效`);
        return flow.stages.find((stage) => stage.id === stageId);
      })
      .filter((stage) => stage !== undefined);

    primaryStages.forEach((stage, index) => {
      const previous = primaryStages[index - 1];
      if (previous && stage.progress <= previous.progress) {
        errors.push(`flow ${flow.id} primary stage progress 必须严格递增`);
      }
    });
    if (primaryStages[0] && Math.abs(primaryStages[0].progress) > epsilon) {
      errors.push(`flow ${flow.id} 第一个 primary stage.progress 必须为 0`);
    }
    if (primaryStages.at(-1) && Math.abs((primaryStages.at(-1)?.progress ?? 0) - 1) > epsilon) {
      errors.push(`flow ${flow.id} 最后一个 primary stage.progress 必须为 1`);
    }

    const primaryTransitions = flow.primaryTransitionIds
      .map((transitionId) => {
        if (!transitionIds.has(transitionId)) {
          errors.push(`flow ${flow.id} primary transition ${transitionId} 无效`);
        }
        return flow.transitions.find((transition) => transition.id === transitionId);
      })
      .filter((transition) => transition !== undefined);

    validatePrimaryPath(
      flow.id,
      primaryTransitions,
      primaryStages[0]?.id,
      primaryStages.at(-1)?.id,
      errors,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Flow model validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  }

  return model;
}
