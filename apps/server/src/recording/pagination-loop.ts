import type { PaginationLoopSelectorCandidate } from "./recording-types.js";

export const PAGINATION_LOOP_ITEM_ORDINAL_TOKEN = "{{itemOrdinal}}";

const NTH_OF_TYPE_PATTERN = /:nth-of-type\(\s*(\d+)\s*\)/g;

export const inferPaginationLoopSelectorCandidates = (
  selector: string,
): PaginationLoopSelectorCandidate[] => {
  const normalizedSelector = selector.trim();
  if (!normalizedSelector) return [];

  const candidates: PaginationLoopSelectorCandidate[] = [];
  for (const match of normalizedSelector.matchAll(NTH_OF_TYPE_PATTERN)) {
    const matchIndex = match.index;
    const sourceOrdinal = Number(match[1]);
    if (matchIndex === undefined || !Number.isSafeInteger(sourceOrdinal) || sourceOrdinal < 1) {
      continue;
    }

    const listSelector = normalizedSelector.slice(0, matchIndex).trimEnd();
    if (!listSelector) continue;

    candidates.push({
      candidateIndex: candidates.length,
      sourceOrdinal,
      listSelector,
      sourceItemSelector: normalizedSelector.slice(0, matchIndex + match[0].length),
      itemSelectorTemplate: `${normalizedSelector.slice(0, matchIndex)}:nth-of-type(${PAGINATION_LOOP_ITEM_ORDINAL_TOKEN})`,
    });
  }

  return candidates;
};
