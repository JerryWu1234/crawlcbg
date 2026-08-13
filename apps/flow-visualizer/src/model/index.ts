import { connections, participants } from "./architecture";
import { dataCatalog } from "./dataCatalog";
import { flows } from "./flows";
import { sourceIndex } from "./sourceIndex";
import { validateFlowModel } from "./validateModel";
import type { FlowModel } from "../types/flow";

const rawModel: FlowModel = {
  title: "crawlcbg Flow Evidence",
  version: "source-model/v1",
  classification: "Source-derived model · 非实时遥测",
  generatedFrom: "当前仓库源码与类型定义；未使用运行样本",
  sources: sourceIndex,
  participants,
  connections,
  dataDetails: dataCatalog,
  flows,
};

export const flowModel = validateFlowModel(rawModel);
